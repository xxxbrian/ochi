package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"ochi/server/internal/storage"
)

const authCookie = "ochi_session"
const loginLifetime = 30 * 24 * time.Hour

type Account struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role,omitempty"`
}

type User = storage.User

type authentication struct {
	store  *storage.Store
	secure bool
}

type userContextKey struct{}

func ParseAccounts(raw string) ([]Account, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("OCHI_USERS is required: configure at least one account")
	}
	var entries []Account
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return nil, fmt.Errorf("OCHI_USERS must be a JSON array: %w", err)
	}
	if len(entries) == 0 {
		return nil, errors.New("OCHI_USERS must contain at least one account")
	}
	accounts := make([]Account, 0, len(entries))
	seen := make(map[string]bool)
	for _, account := range entries {
		account.Username = strings.TrimSpace(account.Username)
		if account.Username == "__admin__" {
			return nil, errors.New("__admin__ is reserved for the extension workspace")
		}
		if account.Username == "" || account.Password == "" {
			return nil, errors.New("each OCHI_USERS account needs username and password")
		}
		if seen[account.Username] {
			return nil, fmt.Errorf("duplicate username %q", account.Username)
		}
		seen[account.Username] = true
		if account.DisplayName == "" {
			account.DisplayName = account.Username
		}
		if account.Role == "" {
			account.Role = "user"
		}
		if account.Role != "user" && account.Role != "admin" {
			return nil, errors.New("account role must be user or admin")
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

func newAuthentication(store *storage.Store, accounts []Account, secure bool) (*authentication, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, account := range accounts {
		if account.Username == "__admin__" {
			return nil, errors.New("__admin__ is reserved for the extension workspace")
		}
		if existing, err := store.GetUser(ctx, account.Username); err == nil && existing.ID != "" {
			continue
		}
		if account.DisplayName == "" {
			account.DisplayName = account.Username
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(account.Password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		role := account.Role
		if role == "" {
			role = "user"
		}
		if role != "user" && role != "admin" {
			return nil, errors.New("account role must be user or admin")
		}
		if err := store.BootstrapUser(ctx, storage.User{ID: account.Username, Username: account.Username, DisplayName: account.DisplayName, Role: role, PasswordHash: string(hash), Enabled: true}); err != nil {
			return nil, err
		}
	}
	if len(accounts) > 0 {
		if err := store.EnsureAdmin(ctx, accounts[0].Username); err != nil {
			return nil, err
		}
	}
	users, err := store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return nil, errors.New("configure at least one initial account")
	}
	return &authentication{store: store, secure: secure}, nil
}
func tokenHash(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

func requestToken(r *http.Request) string {
	// An explicit native credential takes precedence over browser cookie state.
	if value := r.Header.Get("Authorization"); value != "" {
		parts := strings.Fields(value)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			return parts[1]
		}
		return ""
	}
	if cookie, err := r.Cookie(authCookie); err == nil {
		return cookie.Value
	}
	return ""
}

func (a *authentication) require(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := requestToken(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, errors.New("请先登录"))
			return
		}
		user, err := a.store.LoginUser(r.Context(), tokenHash(token))
		if err != nil {
			writeError(w, http.StatusUnauthorized, errors.New("请先登录"))
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userContextKey{}, user)))
	}
}
func (a *authentication) admin(next http.HandlerFunc) http.HandlerFunc {
	return a.require(func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r).Role != "admin" {
			writeError(w, http.StatusForbidden, errors.New("需要管理员权限"))
			return
		}
		next(w, r)
	})
}

func currentUser(r *http.Request) User { return r.Context().Value(userContextKey{}).(User) }

func (a *authentication) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Native   bool   `json:"native"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	user, err := a.store.GetUser(r.Context(), strings.TrimSpace(req.Username))
	if err != nil || !user.Enabled || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, errors.New("用户名或密码不正确"))
		return
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("无法登录"))
		return
	}
	token := hex.EncodeToString(bytes[:])
	expires := time.Now().Add(loginLifetime)
	if previous, err := r.Cookie(authCookie); err == nil {
		_ = a.store.DeleteLogin(r.Context(), tokenHash(previous.Value))
	}
	if err := a.store.CreateLogin(r.Context(), tokenHash(token), user.ID, expires); err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if req.Native {
		writeJSON(w, http.StatusOK, struct {
			User
			AccessToken string    `json:"access_token"`
			ExpiresAt   time.Time `json:"expires_at"`
		}{User: user, AccessToken: token, ExpiresAt: expires})
		return
	}
	http.SetCookie(w, &http.Cookie{Name: authCookie, Value: token, Path: "/", Expires: expires, MaxAge: int(loginLifetime.Seconds()), HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
	writeJSON(w, http.StatusOK, user)
}
func (a *authentication) logout(w http.ResponseWriter, r *http.Request) {
	if token := requestToken(r); token != "" {
		_ = a.store.DeleteLogin(r.Context(), tokenHash(token))
	}
	if cookie, err := r.Cookie(authCookie); err == nil {
		_ = a.store.DeleteLogin(r.Context(), tokenHash(cookie.Value))
	}
	a.clearCookie(w, authCookie)
	w.WriteHeader(http.StatusNoContent)
}

func (a *authentication) webview(w http.ResponseWriter, r *http.Request) {
	next := r.URL.Query().Get("next")
	if r.Method == http.MethodGet && !validWebviewPath(next) {
		writeError(w, http.StatusBadRequest, errors.New("预览地址无效"))
		return
	}
	token := requestToken(r)
	w.Header().Set("Cache-Control", "no-store")
	http.SetCookie(w, &http.Cookie{Name: authCookie, Value: token, Path: "/", MaxAge: int(loginLifetime.Seconds()), HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
	if r.Method == http.MethodGet {
		http.Redirect(w, r, next, http.StatusSeeOther)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validWebviewPath(path string) bool {
	parsed, err := url.ParseRequestURI(path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || strings.ContainsAny(parsed.Path, "\\\r\n") || strings.Contains(parsed.Path, "..") {
		return false
	}
	return strings.HasPrefix(parsed.Path, "/api/") || parsed.Path == "/native/computer" || parsed.Path == "/admin/providers"
}

func (a *authentication) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
}
