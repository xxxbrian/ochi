package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"ochi/server/internal/agent"
)

type desktopSource interface {
	DesktopURL(context.Context, string) (string, error)
	DesktopViewURL(context.Context, string) (string, error)
}

type desktopHub struct {
	mu       sync.Mutex
	controls map[string]map[*desktopConnection]bool
	timers   map[string]*time.Timer
}

func newDesktopHub() *desktopHub {
	return &desktopHub{controls: map[string]map[*desktopConnection]bool{}, timers: map[string]*time.Timer{}}
}
func (h *desktopHub) arm(key string, release func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if timer := h.timers[key]; timer != nil {
		timer.Stop()
	}
	h.timers[key] = time.AfterFunc(30*time.Second, func() {
		h.mu.Lock()
		empty := true
		for _, control := range h.controls[key] {
			if control {
				empty = false
				break
			}
		}
		delete(h.timers, key)
		h.mu.Unlock()
		if empty {
			release()
		}
	})
}
func (h *desktopHub) add(key string, c *desktopConnection, controlled ...bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	control := len(controlled) == 0 || controlled[0]
	if timer := h.timers[key]; timer != nil && control {
		timer.Stop()
		delete(h.timers, key)
	}
	if h.controls[key] == nil {
		h.controls[key] = map[*desktopConnection]bool{}
	}
	h.controls[key][c] = control
}
func (h *desktopHub) remove(key string, c *desktopConnection) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, found := h.controls[key][c]; !found {
		return false
	}
	delete(h.controls[key], c)
	if len(h.controls[key]) == 0 {
		delete(h.controls, key)
	}
	for _, control := range h.controls[key] {
		if control {
			return false
		}
	}
	return true
}
func (h *desktopHub) CloseKey(key string) {
	h.mu.Lock()
	list := []*desktopConnection{}
	for c := range h.controls[key] {
		list = append(list, c)
	}
	delete(h.controls, key)
	if timer := h.timers[key]; timer != nil {
		timer.Stop()
		delete(h.timers, key)
	}
	h.mu.Unlock()
	for _, c := range list {
		_ = c.Close()
	}
}

func (h *desktopHub) CloseControls(key string) {
	h.mu.Lock()
	list := []*desktopConnection{}
	for c, control := range h.controls[key] {
		if control {
			list = append(list, c)
			delete(h.controls[key], c)
		}
	}
	if len(h.controls[key]) == 0 {
		delete(h.controls, key)
	}
	if timer := h.timers[key]; timer != nil {
		timer.Stop()
		delete(h.timers, key)
	}
	h.mu.Unlock()
	for _, c := range list {
		_ = c.Close()
	}
}
func (h *desktopHub) Close() {
	h.mu.Lock()
	keys := map[string]bool{}
	for k := range h.controls {
		keys[k] = true
	}
	for k := range h.timers {
		keys[k] = true
	}
	h.mu.Unlock()
	for key := range keys {
		h.CloseKey(key)
	}
}

type desktopConnection struct {
	io.ReadWriteCloser
	once    sync.Once
	onClose func()
}

func (c *desktopConnection) Close() error {
	err := c.ReadWriteCloser.Close()
	c.once.Do(c.onClose)
	return err
}

func (s *Server) registerComputerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/computer/state", s.auth.require(s.computerState))
	mux.HandleFunc("POST /api/computer/control", s.auth.require(s.computerControl))
	mux.HandleFunc("GET /api/computer/desktop", s.auth.require(s.computerDesktop))
}
func (s *Server) desktopBackend() (desktopSource, error) {
	if wrapped, ok := s.tools.(*personalTools); ok {
		if source, ok := wrapped.source.(desktopSource); ok {
			return source, nil
		}
	}
	return nil, errors.New("电脑暂不可用")
}
func (s *Server) desktopSession(r *http.Request, sessionID string) (agent.RunScope, error) {
	userID := currentUser(r).ID
	scope := agent.RunScope{UserID: userID, WorkspaceID: userID}
	if sessionID == "" {
		return scope, nil
	}
	session, err := s.store.GetSession(r.Context(), userID, sessionID)
	if err != nil {
		return agent.RunScope{}, err
	}
	// Human access to their own computer is independent of agent authorization.
	// The optional session only verifies ownership, never grants agent permission.
	scope.SessionID, scope.CWD, scope.ProjectID = session.ID, session.WorkspacePath, session.ProjectID
	return scope, nil
}
func (s *Server) computerStateValue(ctx context.Context, userID, sessionID string) map[string]any {
	state := s.DesktopState(userID)
	_, err := s.desktopBackend()
	state["available"] = err == nil
	owner, _ := state["owner_session_id"].(string)
	manual, _ := state["manual"].(bool)
	enabled := manual && owner == sessionID
	ownerRun, _ := state["owner_run_id"].(string)
	if run, ok := s.runtime.Get(ownerRun); ok {
		state["owner_status"] = run.Snapshot().Status
	}
	if owner != "" {
		if session, err := s.store.GetSession(ctx, userID, owner); err == nil {
			state["owner_title"] = session.Title
		}
	}
	state["session_id"] = sessionID
	state["control_enabled"] = enabled
	state["view_only"] = !enabled
	address := "/api/computer/desktop"
	query := url.Values{}
	if sessionID != "" {
		query.Set("session_id", sessionID)
	}
	if enabled {
		query.Set("control", "1")
	}
	if len(query) > 0 {
		address += "?" + query.Encode()
	}
	state["desktop_url"] = address
	return state
}
func (s *Server) computerState(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("session_id")
	if _, err := s.desktopSession(r, id); err != nil {
		writeStartError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.computerStateValue(r.Context(), currentUser(r).ID, id))
}
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Host == r.Host
}
func (s *Server) activateDesktop(ctx context.Context, scope agent.RunScope) error {
	bridge, err := s.bridgeSource()
	if err != nil {
		return err
	}
	status, _, body, err := bridge.Bridge(agent.WithRunScope(ctx, scope), scope.UserID, http.MethodPost, "/desktop/activate", []byte(`{}`))
	if err != nil || status >= 400 {
		return bridgeError(status, body, err)
	}
	return nil
}
func (s *Server) computerControl(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, errors.New("无法访问"))
		return
	}
	var req struct {
		SessionID string `json:"session_id"`
		Enabled   bool   `json:"enabled"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	scope, err := s.desktopSession(r, req.SessionID)
	if err != nil {
		writeStartError(w, err)
		return
	}
	key := desktopConnectionKey(scope.UserID, scope.SessionID)
	if !req.Enabled {
		s.desktops.CloseControls(key)
		s.ReleaseDesktopControl(scope.UserID, scope.SessionID)
		writeJSON(w, http.StatusOK, s.computerStateValue(r.Context(), scope.UserID, scope.SessionID))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	if err = s.AcquireDesktopControl(ctx, scope.UserID, scope.SessionID); err != nil {
		writeError(w, http.StatusRequestTimeout, errors.New("等待电脑已取消"))
		return
	}
	// Provision the desktop without selecting a session tab or starting a browser.
	// Taking control must not silently change the screen that the user is viewing.
	source, err := s.desktopBackend()
	if err == nil {
		_, err = source.DesktopURL(ctx, scope.UserID)
	}
	if err != nil {
		s.ReleaseDesktopControl(scope.UserID, scope.SessionID)
		writeError(w, http.StatusBadGateway, err)
		return
	}
	s.desktops.arm(key, func() { s.ReleaseDesktopControl(scope.UserID, scope.SessionID) })
	writeJSON(w, http.StatusOK, s.computerStateValue(r.Context(), scope.UserID, scope.SessionID))
}
func (s *Server) computerDesktop(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, errors.New("无法访问"))
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeError(w, http.StatusBadRequest, errors.New("需要 WebSocket 连接"))
		return
	}
	scope, err := s.desktopSession(r, r.URL.Query().Get("session_id"))
	if err != nil {
		writeStartError(w, err)
		return
	}
	source, err := s.desktopBackend()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	control := r.URL.Query().Get("control") == "1"
	state := s.computerStateValue(r.Context(), scope.UserID, scope.SessionID)
	if control && state["control_enabled"] != true {
		writeError(w, http.StatusForbidden, errors.New("请先接管电脑"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	var address string
	if control {
		address, err = source.DesktopURL(ctx, scope.UserID)
	} else {
		address, err = source.DesktopViewURL(ctx, scope.UserID)
	}
	cancel()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	target, err := url.Parse(address)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	target.Scheme = "http"
	proxy := httputil.NewSingleHostReverseProxy(target)
	original := proxy.Director
	proxy.Director = func(req *http.Request) {
		original(req)
		req.URL.Path = target.Path
		req.URL.RawQuery = ""
		req.Host = target.Host
		req.Header.Del("Cookie")
		req.Header.Del("Authorization")
		req.Header.Del("Origin")
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.StatusCode != http.StatusSwitchingProtocols {
			return errors.New("远程桌面连接失败")
		}
		{
			upstream, ok := resp.Body.(io.ReadWriteCloser)
			if !ok {
				return errors.New("远程桌面连接不可用")
			}
			key := desktopConnectionKey(scope.UserID, scope.SessionID)
			if control && s.computerStateValue(r.Context(), scope.UserID, scope.SessionID)["control_enabled"] != true {
				_ = upstream.Close()
				return errors.New("电脑接管已结束")
			}
			conn := &desktopConnection{ReadWriteCloser: upstream}
			conn.onClose = func() {
				if s.desktops.remove(key, conn) && control {
					// A reconnect may replace the socket. Explicit release is immediate;
					// an unexpected disconnect gives the client a brief recovery window.
					s.desktops.arm(key, func() { s.ReleaseDesktopControl(scope.UserID, scope.SessionID) })
				}
			}
			s.desktops.add(key, conn, control)
			resp.Body = conn
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		writeError(w, http.StatusBadGateway, errors.New("远程桌面连接失败"))
	}
	proxy.ServeHTTP(w, r)
}
func desktopConnectionKey(userID, sessionID string) string {
	return userID + ":" + desktopControlID(sessionID)
}
