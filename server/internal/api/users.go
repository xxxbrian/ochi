package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"

	"ochi/server/internal/i18n"
	"ochi/server/internal/storage"
	"ochi/server/internal/workspace"
)

type userWorkspaceRemover interface {
	RemoveUser(context.Context, string, []string) error
}

func (s *Server) removeUserWorkspaces(ctx context.Context, userID string, sessionIDs []string) error {
	source := s.tools
	if wrapped, ok := source.(*personalTools); ok {
		source = wrapped.source
	}
	if source == nil {
		return nil
	}
	remover, ok := source.(userWorkspaceRemover)
	if !ok {
		return i18n.New("computer_unavailable")
	}
	if err := remover.RemoveUser(ctx, userID, sessionIDs); err != nil {
		if errors.Is(err, workspace.ErrUserBusy) {
			return storage.ErrAccountBusy
		}
		log.Printf("remove user workspace: %v", err)
		return i18n.Wrap("workspace_delete_failed", err)
	}
	// This runs only after all live account admissions and workspace Jobs have
	// been excluded. A future visit may create a fresh workspace for a reset.
	s.desktops.CloseKey(desktopConnectionKey(userID, ""))
	for _, sessionID := range sessionIDs {
		s.desktops.CloseKey(desktopConnectionKey(userID, sessionID))
	}
	s.resources.releaseUser(userID)
	return nil
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if userID == currentUser(r).ID {
		writeError(w, http.StatusBadRequest, i18n.New("user_delete_self"))
		return
	}
	finish, err := s.accounts.maintain(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer finish()
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	var deletedSessions []string
	err = s.store.DeleteUser(ctx, currentUser(r).ID, userID, func(ctx context.Context, sessions []string) error {
		if err := s.removeUserWorkspaces(ctx, userID, sessions); err != nil {
			return err
		}
		if err := os.RemoveAll(filepath.Join(artifactsRoot(), artifactUserKey(userID))); err != nil {
			log.Printf("remove user artifact files: %v", err)
			return i18n.Wrap("user_delete_failed", err)
		}
		deletedSessions = sessions
		return nil
	})
	if err != nil {
		writeUserMaintenanceError(w, err)
		return
	}
	s.runtime.ForgetSessions(deletedSessions)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteWorkspace(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if userID == "__admin__" {
		writeError(w, http.StatusBadRequest, i18n.New("workspace_control_protected"))
		return
	}
	finish, err := s.accounts.maintain(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer finish()
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	sessions, err := s.store.UserWorkspaceSessions(ctx, userID)
	if err == nil {
		err = s.removeUserWorkspaces(ctx, userID, sessions)
	}
	if err != nil {
		writeUserMaintenanceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeUserMaintenanceError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, storage.ErrAccountBusy) {
		writeStoreError(w, err)
		return
	}
	if code, _, public := i18n.Details(err); public {
		status := http.StatusBadRequest
		if code == "workspace_delete_failed" || code == "user_delete_failed" || code == "computer_unavailable" {
			status = http.StatusBadGateway
		}
		writeError(w, status, err)
		return
	}
	log.Printf("delete user data: %v", err)
	writeError(w, http.StatusInternalServerError, i18n.New("user_delete_failed"))
}
