package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

func (s *server) handleListLabels(w http.ResponseWriter, r *http.Request) {
	labels, err := s.db.ListLabels(getClaims(r).UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	if labels == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, labels)
}

func (s *server) handleCreateLabel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	color := body.Color
	if color == "" {
		color = "#6366f1"
	}
	l, err := s.db.CreateLabel(getClaims(r).UserID, name, color)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create label")
		return
	}
	writeJSON(w, http.StatusCreated, l)
}

func (s *server) handleUpdateLabel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	if err := s.db.UpdateLabel(id, getClaims(r).UserID, name, body.Color); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update label")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleDeleteLabel(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.db.DeleteLabel(id, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete label")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleAssignLabel(w http.ResponseWriter, r *http.Request) {
	comicID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid comic id")
		return
	}
	labelID, err := strconv.ParseInt(chi.URLParam(r, "label_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid label id")
		return
	}
	if err := s.db.AssignLabel(comicID, labelID, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not assign label")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleUnassignLabel(w http.ResponseWriter, r *http.Request) {
	comicID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid comic id")
		return
	}
	labelID, err := strconv.ParseInt(chi.URLParam(r, "label_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid label id")
		return
	}
	if err := s.db.UnassignLabel(comicID, labelID, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not unassign label")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
