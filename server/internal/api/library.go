package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

// --- library paths (admin) ---

func (s *server) handleListLibraryPaths(w http.ResponseWriter, r *http.Request) {
	paths, err := s.db.ListLibraryPaths()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	if paths == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, paths)
}

func (s *server) handleAddLibraryPath(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	path := strings.TrimSpace(body.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	// Resolve and verify the path exists and is a directory
	abs, err := filepath.Abs(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		writeError(w, http.StatusBadRequest, "path does not exist")
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a directory")
		return
	}
	p, err := s.db.AddLibraryPath(abs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not add path (already exists?)")
		return
	}
	// Kick off a scan in the background to pick up the new path immediately
	go s.scanner.Scan()
	writeJSON(w, http.StatusCreated, p)
}

func (s *server) handleRemoveLibraryPath(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.db.RemoveLibraryPath(id); err != nil {
		writeError(w, http.StatusInternalServerError, "could not remove path")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- ignored paths (admin) ---

func (s *server) handleListIgnoredPaths(w http.ResponseWriter, r *http.Request) {
	paths, err := s.db.ListIgnoredPaths()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	if paths == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, paths)
}

func (s *server) handleUnignorePath(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Path == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	if err := s.db.RemoveIgnoredPath(body.Path); err != nil {
		writeError(w, http.StatusInternalServerError, "could not unignore")
		return
	}
	// Trigger a rescan so the unhidden file shows up
	go s.scanner.Scan()
	w.WriteHeader(http.StatusNoContent)
}

// --- comic removal (admin) ---

// handleRemoveComic removes a comic from the library. By default it also
// adds the file path to the ignore list so future scans won't re-add it.
// With ?delete_file=1, the file itself is deleted from disk — and in that
// case the ignore list is skipped because there's nothing left to ignore
// (the file is gone, scans can't find it on the next pass).
func (s *server) handleRemoveComic(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	c, err := s.db.GetComicByID(id)
	if err != nil || c == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	q := r.URL.Query()
	ignore := q.Get("ignore") != "0" // default true
	deleteFile := q.Get("delete_file") == "1"
	// File deletion makes the ignore-list entry redundant — keeping it
	// would just leave a stale row pointing to a now-nonexistent path.
	if deleteFile {
		ignore = false
	}

	if ignore {
		if err := s.db.AddIgnoredPath(c.Path); err != nil {
			writeError(w, http.StatusInternalServerError, "could not add to ignore list")
			return
		}
	}
	if err := s.db.DeleteComicByPath(c.Path); err != nil {
		writeError(w, http.StatusInternalServerError, "could not remove comic")
		return
	}
	if c.CoverPath != "" {
		os.Remove(c.CoverPath)
	}
	if deleteFile {
		if err := os.Remove(c.Path); err != nil {
			// File deletion is best-effort; still report the deletion as a success
			// since the DB entry is gone. Surface a soft warning.
			writeJSON(w, http.StatusOK, map[string]any{
				"removed":     true,
				"file_warn":   err.Error(),
				"file_delete": false,
			})
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
