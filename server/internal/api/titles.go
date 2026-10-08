package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"ochi/server/internal/agent"
	"ochi/server/internal/storage"
)

// Fixed instructions and a separate completion keep title work out of the
// canonical conversation and preserve the main agent's cached prefix.
const titlePolicy = `Generate a useful sidebar title for the conversation described by the user's first message.
Use the user's language. Name the specific topic or requested deliverable, preserving important names and distinguishing details.
Prefer 8-24 Chinese characters or 3-10 English words; shorter is acceptable for a naturally short topic. Avoid vague titles such as "Question", "Help", or "New chat".
Do not simply copy the user's request. No introductory text, quotation marks, Markdown, or ending punctuation. Output only the title.`

func cleanGeneratedTitle(raw string) (string, error) {
	title := strings.TrimSpace(raw)
	title = strings.Trim(title, "\"'`“”‘’")
	title = strings.TrimSpace(strings.TrimRight(title, ".。!！?？"))
	if title == "" || strings.ContainsAny(title, "\r\n") || !utf8.ValidString(title) || len([]rune(title)) > 80 {
		return "", errors.New("invalid generated title")
	}
	return title, nil
}

func (s *Server) asyncTitle(request agent.Request) {
	if request.Config == nil || request.Config.Model == "" {
		return
	}
	s.launchBackground(func(parent context.Context) {
		for attempt := 0; attempt < 2; attempt++ {
			if parent.Err() != nil {
				return
			}
			ctx, cancel := context.WithTimeout(parent, 60*time.Second)
			claim, err := s.store.ClaimTitle(ctx, request.UserID, request.SessionID)
			if err != nil {
				cancel()
				return
			}
			config := agent.AuxiliaryConfig(*request.Config)
			settings, settingsErr := s.store.Settings(ctx)
			if settingsErr == nil && settings.TitleModelID != "" {
				if selected, selectErr := s.auxiliaryModel(ctx, settings.TitleModelID); selectErr == nil && selected != nil {
					config = *selected
				}
			}
			names := []string{}
			for _, file := range claim.Attachments {
				names = append(names, file.Name)
			}
			input, _ := json.Marshal(map[string]any{"message": trimRunes(claim.Prompt, 3000), "attachments": names})
			response, err := agent.Complete(ctx, config, titlePolicy, string(input), 2048)
			if err == nil {
				var title string
				title, err = cleanGeneratedTitle(response)
				if err == nil {
					err = s.store.PublishTitle(ctx, request.UserID, request.SessionID, claim, title)
				}
			}
			cancel()
			if err == nil {
				return
			}
			log.Printf("session title %s: %s", request.SessionID, storage.SanitizeProviderError(storage.Provider{APIKey: config.APIKey, Headers: config.Headers}, err))
			save, done := context.WithTimeout(parent, 5*time.Second)
			_ = s.store.ReleaseTitle(save, request.UserID, request.SessionID, claim)
			done()
			if attempt == 0 {
				timer := time.NewTimer(time.Second)
				select {
				case <-parent.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
	})
}
