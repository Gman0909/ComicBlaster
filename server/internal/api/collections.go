package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

func (s *server) handleListCollections(w http.ResponseWriter, r *http.Request) {
	cols, err := s.db.ListCollections(getClaims(r).UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	if cols == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, cols)
}

func (s *server) handleCreateCollection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
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
	c, err := s.db.CreateCollection(getClaims(r).UserID, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create collection")
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *server) handleUpdateCollection(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Name string `json:"name"`
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
	if err := s.db.UpdateCollection(id, getClaims(r).UserID, name); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update collection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleDeleteCollection(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.db.DeleteCollection(id, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete collection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleAddToCollection(w http.ResponseWriter, r *http.Request) {
	collectionID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid collection id")
		return
	}
	comicID, err := strconv.ParseInt(chi.URLParam(r, "comic_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid comic id")
		return
	}
	if err := s.db.AddToCollection(collectionID, comicID, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not add to collection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleRemoveFromCollection(w http.ResponseWriter, r *http.Request) {
	collectionID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid collection id")
		return
	}
	comicID, err := strconv.ParseInt(chi.URLParam(r, "comic_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid comic id")
		return
	}
	if err := s.db.RemoveFromCollection(collectionID, comicID, getClaims(r).UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not remove from collection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleReorderCollection(w http.ResponseWriter, r *http.Request) {
	collectionID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		ComicIDs []int64 `json:"comic_ids"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.db.ReorderCollection(collectionID, getClaims(r).UserID, body.ComicIDs); err != nil {
		writeError(w, http.StatusInternalServerError, "could not reorder")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
