package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"comicblaster/internal/auth"
)

func (s *server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.db.ListUsers()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	type userResp struct {
		ID        int64  `json:"id"`
		Username  string `json:"username"`
		Email     string `json:"email"`
		Role      string `json:"role"`
		CreatedAt string `json:"created_at"`
	}
	out := make([]userResp, len(users))
	for i, u := range users {
		out[i] = userResp{u.ID, u.Username, u.Email, u.Role, u.CreatedAt.Format(time.RFC3339)}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
		Role     string `json:"role"`
	}
	if err := decode(r, &body); err != nil || body.Username == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password required")
		return
	}
	if body.Role != "admin" && body.Role != "user" {
		body.Role = "user"
	}

	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	id, err := s.db.CreateUser(body.Username, body.Email, hash, body.Role)
	if err != nil {
		writeError(w, http.StatusConflict, "username already exists")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "username": body.Username, "role": body.Role})
}

func (s *server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if id == getClaims(r).UserID {
		writeError(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}
	if err := s.db.DeleteUser(id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := decode(r, &body); err != nil || body.Password == "" {
		writeError(w, http.StatusBadRequest, "password required")
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := s.db.UpdateUserPassword(id, hash); err != nil {
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
