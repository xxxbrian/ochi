package api

import "net/http"

func (s *Server) getSessionHead(w http.ResponseWriter, r *http.Request) {
	head, err := s.store.SessionHead(r.Context(), currentUser(r).ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if head.LatestRun != nil {
		if live, ok := s.runtime.Get(head.LatestRun.RunID); ok {
			latest := live.Head()
			head.LatestRun = &latest
		}
	}
	writeJSON(w, http.StatusOK, head)
}
