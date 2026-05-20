package api

import (
	"net/http"
	"time"

	"comicblaster/internal/auth"
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

	s.setTokenCookie(w, id, "admin")
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "username": body.Username, "role": "admin",
	})
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

	s.setTokenCookie(w, user.ID, user.Role)
	writeJSON(w, http.StatusOK, map[string]any{
		"id": user.ID, "username": user.Username, "role": user.Role,
	})
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
	writeJSON(w, http.StatusOK, map[string]any{
		"id": user.ID, "username": user.Username, "email": user.Email, "role": user.Role,
	})
}

func (s *server) setTokenCookie(w http.ResponseWriter, userID int64, role string) {
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
}
