package agent

import (
	"encoding/json"
	"strconv"
	"strings"
)

type reasoningStream struct {
	prefix   string
	emit     func(Update) error
	parts    map[string]*ReasoningPart
	order    []string
	segments map[string]int
}

func newReasoningStream(prefix string, emit func(Update) error) *reasoningStream {
	return &reasoningStream{prefix: prefix, emit: emit, parts: map[string]*ReasoningPart{}, segments: map[string]int{}}
}

func (s *reasoningStream) delta(kind, text string) error {
	if text == "" {
		return nil
	}
	segment := s.segments[kind]
	key := kind
	if segment > 1 {
		key += ":segment-" + strconv.Itoa(segment)
	}
	if part := s.parts[key]; part != nil && part.Done {
		segment++
		key = kind + ":segment-" + strconv.Itoa(segment)
	}
	if segment == 0 {
		segment = 1
	}
	s.segments[kind] = segment
	return s.part(kind, key, text)
}

func (s *reasoningStream) part(kind, key, text string) error {
	if text == "" {
		return nil
	}
	part := s.parts[key]
	if part == nil {
		part = &ReasoningPart{ID: s.prefix + ":" + key, Kind: kind}
		s.parts[key] = part
		s.order = append(s.order, key)
	}
	part.Text += text
	return s.emit(Update{Reasoning: &ReasoningPart{ID: part.ID, Kind: part.Kind, Text: text, Done: part.Done}})
}

// Completed item snapshots may contain a final suffix after text.done. Keep its
// identity and completion state rather than reopening it as a new occurrence.
func (s *reasoningStream) snapshot(kind, key, text string, done bool) error {
	before := ""
	if part := s.parts[key]; part != nil {
		before = part.Text
	}
	if strings.HasPrefix(text, before) && len(text) > len(before) {
		if err := s.part(kind, key, text[len(before):]); err != nil {
			return err
		}
	}
	if done {
		return s.finish(key)
	}
	return nil
}

func (s *reasoningStream) finish(key string) error {
	part := s.parts[key]
	if part == nil || part.Done {
		return nil
	}
	part.Done = true
	return s.emit(Update{Reasoning: &ReasoningPart{ID: part.ID, Kind: part.Kind, Done: true}})
}

func (s *reasoningStream) done() error {
	for _, key := range s.order {
		if err := s.finish(key); err != nil {
			return err
		}
	}
	return nil
}

type returnedReasoningPart struct {
	Kind, Text, ID string
	Index          *int
	slot           string
}

// Only documented plaintext fields are renderable. Signatures, encrypted
// reasoning and arbitrary provider objects are replay state, not UI content.
func returnedReasoningParts(raw json.RawMessage, kind, slot string) []returnedReasoningPart {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if text == "" {
			return nil
		}
		return []returnedReasoningPart{{Kind: kind, Text: text, slot: slot}}
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) == nil {
		result := []returnedReasoningPart{}
		for index, part := range parts {
			childSlot := slot
			if len(parts) > 1 {
				childSlot += "/" + strconv.Itoa(index)
			}
			result = append(result, returnedReasoningParts(part, kind, childSlot)...)
		}
		return result
	}
	var part struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Summary string `json:"summary"`
		ID      string `json:"id"`
		Index   *int   `json:"index"`
	}
	if json.Unmarshal(raw, &part) != nil {
		return nil
	}
	switch part.Type {
	case "", "text":
	case "reasoning.text":
		kind = "reasoning"
	case "summary_text", "reasoning.summary":
		kind = "summary"
	default:
		return nil
	}
	if part.Text == "" {
		part.Text = part.Summary
	}
	return []returnedReasoningPart{{Kind: kind, Text: part.Text, ID: part.ID, Index: part.Index, slot: slot}}
}

func returnedReasoningDetails(raw json.RawMessage) []returnedReasoningPart {
	var details []json.RawMessage
	if json.Unmarshal(raw, &details) != nil {
		return nil
	}
	parts := []returnedReasoningPart{}
	for index, raw := range details {
		var detail struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &detail)
		switch detail.Type {
		case "reasoning.text", "reasoning.summary", "summary_text":
			slot := ""
			if len(details) > 1 {
				slot = "/" + strconv.Itoa(index)
			}
			parts = append(parts, returnedReasoningParts(raw, "reasoning", slot)...)
		}
	}
	return parts
}

type chatReasoningIdentity struct {
	key, id, slot string
	index         *int
}

type chatReasoningStream struct {
	visible *reasoningStream
	parts   map[string][]*chatReasoningIdentity
	current map[string]*chatReasoningIdentity
}

func newChatReasoningStream(visible *reasoningStream) *chatReasoningStream {
	return &chatReasoningStream{visible: visible, parts: map[string][]*chatReasoningIdentity{}, current: map[string]*chatReasoningIdentity{}}
}

func (s *chatReasoningStream) identity(source string, part returnedReasoningPart) *chatReasoningIdentity {
	scope := "chat-" + source + "-" + part.Kind
	current := s.current[scope]
	var match *chatReasoningIdentity
	for i := len(s.parts[scope]) - 1; i >= 0; i-- {
		candidate := s.parts[scope][i]
		if part.ID != "" && candidate.id != "" && candidate.id != part.ID || part.Index != nil && candidate.index != nil && *candidate.index != *part.Index {
			continue
		}
		if part.ID != "" && candidate.id == part.ID || part.Index != nil && candidate.index != nil && *candidate.index == *part.Index {
			match = candidate
			break
		}
		if part.ID == "" && part.Index == nil && (part.slot == "" && candidate == current || part.slot != "" && candidate.slot == part.slot) {
			if state := s.visible.parts[candidate.key]; state == nil || !state.Done {
				match = candidate
				break
			}
		}
	}
	if match == nil && current != nil && current.id == "" && current.index == nil && part.slot == current.slot {
		if state := s.visible.parts[current.key]; state == nil || !state.Done {
			match = current
		}
	}
	if match == nil {
		match = &chatReasoningIdentity{key: scope + "-" + strconv.Itoa(len(s.parts[scope])+1), slot: part.slot}
		s.parts[scope] = append(s.parts[scope], match)
	}
	if part.ID != "" {
		match.id = part.ID
	}
	if part.Index != nil {
		match.index = part.Index
	}
	s.current[scope] = match
	return match
}

func (s *chatReasoningStream) delta(content string, reasoning, summary, details json.RawMessage) error {
	channels := []struct {
		name  string
		parts []returnedReasoningPart
	}{
		{"details", returnedReasoningDetails(details)},
		{"reasoning", returnedReasoningParts(reasoning, "reasoning", "")},
		{"summary", returnedReasoningParts(summary, "summary", "")},
		{"content", nil},
	}
	if content != "" {
		channels[len(channels)-1].parts = []returnedReasoningPart{{Kind: "reasoning", Text: content}}
	}
	seen := map[string][][]returnedReasoningPart{}
	for _, channel := range channels {
		byKind := map[string][]returnedReasoningPart{}
		for _, part := range channel.parts {
			byKind[part.Kind] = append(byKind[part.Kind], part)
		}
		mirrored := map[string]bool{}
		for kind, parts := range byKind {
			for _, prior := range seen[kind] {
				if sameFrameReasoningAlias(prior, parts) {
					mirrored[kind] = true
					break
				}
			}
			if mirrored[kind] {
				// A suppressed anonymous channel must not later append into an
				// older position. Source transitions, not tokens, end occurrences.
				scope := "chat-" + channel.name + "-" + kind
				for _, identity := range s.parts[scope] {
					if identity.id == "" && identity.index == nil {
						if err := s.visible.finish(identity.key); err != nil {
							return err
						}
					}
				}
			} else {
				seen[kind] = append(seen[kind], parts)
			}
		}
		for _, part := range channel.parts {
			if mirrored[part.Kind] {
				continue
			}
			identity := s.identity(channel.name, part)
			if err := s.visible.part(part.Kind, identity.key, part.Text); err != nil {
				return err
			}
		}
	}
	return nil
}

func sameFrameReasoningAlias(first, second []returnedReasoningPart) bool {
	text := func(parts []returnedReasoningPart) (string, bool) {
		var joined strings.Builder
		identified := false
		for _, part := range parts {
			joined.WriteString(part.Text)
			identified = identified || part.ID != "" || part.Index != nil
		}
		return joined.String(), identified
	}
	before, firstIdentified := text(first)
	after, secondIdentified := text(second)
	if before == "" || before != after {
		return false
	}
	// A scalar alias may mirror several structured parts, but two structured
	// channels with conflicting identities or boundaries are distinct content.
	if firstIdentified && secondIdentified || len(first) > 1 && len(second) > 1 {
		if len(first) != len(second) {
			return false
		}
		for index, a := range first {
			b := second[index]
			if a.Text != b.Text || a.ID != "" && b.ID != "" && a.ID != b.ID || a.Index != nil && b.Index != nil && *a.Index != *b.Index {
				return false
			}
		}
	}
	return true
}

func appendReasoningValue(previous, next json.RawMessage) json.RawMessage {
	var before, after string
	if json.Unmarshal(next, &after) == nil {
		if len(previous) == 0 || json.Unmarshal(previous, &before) == nil {
			result, _ := json.Marshal(before + after)
			return result
		}
	}
	values := func(raw json.RawMessage) []json.RawMessage {
		var parts []json.RawMessage
		if len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &parts) != nil {
			parts = []json.RawMessage{raw}
		}
		return parts
	}
	prior, _ := json.Marshal(values(previous))
	added, _ := json.Marshal(values(next))
	result := appendReasoningDetails(prior, added)
	if strings.HasPrefix(strings.TrimSpace(string(next)), "{") && (len(previous) == 0 || strings.HasPrefix(strings.TrimSpace(string(previous)), "{")) {
		var parts []json.RawMessage
		if json.Unmarshal(result, &parts) == nil && len(parts) == 1 {
			return parts[0]
		}
	}
	return result
}
