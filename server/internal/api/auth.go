package api

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"comicblaster/internal/auth"
	"comicblaster/internal/storage"
)

func (s *server) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"setup_needed": !s.db.HasUsers()})
}

func (s *server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if s.db.HasUsers() {
		writeError(w, http.StatusForbidden, "setup already complete")
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := decode(r, &body); err != nil || body.Username == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password required")
		return
	}

	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	id, err := s.db.CreateUser(body.Username, body.Email, hash, "admin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create user")
		return
	}

	resp := map[string]any{"id": id, "username": body.Username, "role": "admin"}
	s.attachToken(w, r, id, "admin", resp)
	writeJSON(w, http.StatusCreated, resp)
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}

	user, err := s.db.GetUserByUsername(body.Username)
	if err != nil || user == nil || !auth.CheckPassword(user.PasswordHash, body.Password) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	resp := userResp(user)
	s.attachToken(w, r, user.ID, user.Role, resp)
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "cb_token",
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decode(r, &body); err != nil || body.Current == "" || body.New == "" {
		writeError(w, http.StatusBadRequest, "current and new password required")
		return
	}
	claims := getClaims(r)
	user, err := s.db.GetUserByID(claims.UserID)
	if err != nil || user == nil {
		writeError(w, http.StatusUnauthorized, "user not found")
		return
	}
	if !auth.CheckPassword(user.PasswordHash, body.Current) {
		writeError(w, http.StatusUnauthorized, "incorrect current password")
		return
	}
	hash, err := auth.HashPassword(body.New)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := s.db.UpdateUserPassword(claims.UserID, hash); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update password")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	user, err := s.db.GetUserByID(claims.UserID)
	if err != nil || user == nil {
		writeError(w, http.StatusUnauthorized, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, userResp(user))
}

// userResp builds the JSON shape the client expects for /auth/me +
// login responses. Centralised so all the entry points include
// preferences (otherwise the client can't hydrate sort/order from
// the server on cold start).
func userResp(u *storage.User) map[string]any {
	prefs := u.Preferences
	if prefs == "" {
		prefs = "{}"
	}
	// Send as parsed JSON so the client doesn't have to JSON.parse a
	// string field. json.RawMessage type-asserts to whatever's in
	// the blob; defaults to {} for users without anything set.
	return map[string]any{
		"id":          u.ID,
		"username":    u.Username,
		"email":       u.Email,
		"role":        u.Role,
		"preferences": json.RawMessage(prefs),
	}
}

// handlePutPreferences accepts an arbitrary JSON object and stores
// it verbatim against the calling user. No server-side schema —
// the client owns the shape (today: { sort, order }; tomorrow:
// whatever it wants).
func (s *server) handlePutPreferences(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	// Slurp the body raw; validate that it parses as JSON so we
	// don't store something the client can't deserialise. Cap at
	// 16 KB to bound the row size; preferences should be tiny.
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read body")
		return
	}
	var probe any
	if err := json.Unmarshal(body, &probe); err != nil {
		writeError(w, http.StatusBadRequest, "preferences must be valid JSON")
		return
	}
	if err := s.db.UpdatePreferences(claims.UserID, string(body)); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save preferences")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// attachToken always issues a fresh JWT and sets the httpOnly cookie used
// by the browser client. When the caller asks for it (X-Want-Token: 1 or
// ?token=1 — used by native clients that can't read cookies because
// they're served from a non-HTTP origin), the same token is added to the
// response body under "token" so the client can stash it in the OS
// keyring and replay it via Authorization: Bearer.
//
// The cookie path is harmless for native clients (they ignore it) and
// preserves the browser flow exactly.
func (s *server) attachToken(w http.ResponseWriter, r *http.Request, userID int64, role string, resp map[string]any) {
	token, err := auth.IssueToken(userID, role)
	if err != nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "cb_token",
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	if r.Header.Get("X-Want-Token") == "1" || r.URL.Query().Get("token") == "1" {
		resp["token"] = token
	}
}
