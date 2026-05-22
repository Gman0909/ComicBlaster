package api

import (
	"bytes"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/go-chi/chi/v5"

	"comicblaster/internal/reader"
	"comicblaster/internal/storage"
)

// --- response types ---

type comicResp struct {
	ID           int64                 `json:"id"`
	Title        string                `json:"title"`
	Series       string                `json:"series,omitempty"`
	Volume       *int                  `json:"volume,omitempty"`
	Issue        *float64              `json:"issue,omitempty"`
	Format       string                `json:"format"`
	PageCount    int                   `json:"page_count"`
	FileSize     int64                 `json:"file_size"`
	CoverURL     string                `json:"cover_url"`
	CustomCover  bool                  `json:"custom_cover"`
	DateAdded    string                `json:"date_added"`
	MissingSince string                `json:"missing_since,omitempty"` // RFC3339; empty when file is present
	Progress     *progressResp         `json:"progress,omitempty"`
	Labels       []*storage.Label      `json:"labels"`
	Collections  []*storage.Collection `json:"collections"`
}

type progressResp struct {
	LastPage  int    `json:"last_page"`
	LastCFI   string `json:"last_cfi,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func toComicResp(c *storage.ComicWithProgress) comicResp {
	coverURL := "/api/comics/" + strconv.FormatInt(c.ID, 10) + "/cover"
	// Pin the cover URL to the file's mtime so changing the cover file produces
	// a new URL — the browser fetches fresh content automatically, with no
	// client-side cache-busting needed.
	if c.CoverPath != "" {
		if info, err := os.Stat(c.CoverPath); err == nil {
			coverURL += "?v=" + strconv.FormatInt(info.ModTime().Unix(), 10)
		}
	}
	cr := comicResp{
		ID:          c.ID,
		Title:       c.Title,
		Series:      c.Series,
		Volume:      c.Volume,
		Issue:       c.Issue,
		Format:      c.Format,
		PageCount:   c.PageCount,
		FileSize:    c.FileSize,
		CoverURL:    coverURL,
		CustomCover: c.CustomCover,
		DateAdded:   c.DateAdded.Format(time.RFC3339),
	}
	if c.MissingSince != nil {
		cr.MissingSince = c.MissingSince.Format(time.RFC3339)
	}
	if c.LastPage != nil && c.ProgressUpdatedAt != nil {
		cr.Progress = &progressResp{
			LastPage:  *c.LastPage,
			UpdatedAt: c.ProgressUpdatedAt.Format(time.RFC3339),
		}
		if c.LastCFI != nil {
			cr.Progress.LastCFI = *c.LastCFI
		}
	}
	cr.Labels = []*storage.Label{}
	cr.Collections = []*storage.Collection{}
	return cr
}

// --- handlers ---

func (s *server) handleListComics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	perPage, _ := strconv.Atoi(q.Get("per_page"))
	// label_id / collection_id accept either a single value or a
	// comma-separated list ("3,7,12") to AND-filter on multiple at once.
	labelIDs := parseCSVInts(q.Get("label_id"))
	collectionIDs := parseCSVInts(q.Get("collection_id"))
	unread := q.Get("unread") == "1"
	// Settings → Missing files toggle. When set, the response also
	// includes comics flagged with missing_since (typically hidden so
	// the library doesn't show broken thumbnails).
	includeMissing := q.Get("include_missing") == "1"
	userID := getClaims(r).UserID

	comics, total, err := s.db.ListComics(storage.ListComicsParams{
		UserID:         userID,
		Search:         q.Get("search"),
		Sort:           q.Get("sort"),
		Order:          q.Get("order"),
		Format:         q.Get("format"),
		LabelIDs:       labelIDs,
		CollectionIDs:  collectionIDs,
		UnreadOnly:     unread,
		IncludeMissing: includeMissing,
		Page:           page,
		PerPage:        perPage,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}

	ids := make([]int64, len(comics))
	for i, c := range comics {
		ids[i] = c.ID
	}
	labelsByID, _ := s.db.LabelsForComics(userID, ids)
	collsByID, _ := s.db.CollectionsForComics(userID, ids)

	out := make([]comicResp, len(comics))
	for i, c := range comics {
		out[i] = toComicResp(c)
		if labels := labelsByID[c.ID]; labels != nil {
			out[i].Labels = labels
		}
		if cols := collsByID[c.ID]; cols != nil {
			out[i].Collections = cols
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"comics":   out,
		"total":    total,
		"page":     page,
		"per_page": perPage,
	})
}

func (s *server) handleGetComic(w http.ResponseWriter, r *http.Request) {
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
	uid := getClaims(r).UserID
	cwp := &storage.ComicWithProgress{Comic: *c}
	if p, _ := s.db.GetProgress(uid, id); p != nil {
		cwp.LastPage = &p.LastPage
		cwp.LastCFI = &p.LastCFI
		cwp.ProgressUpdatedAt = &p.UpdatedAt
	}
	resp := toComicResp(cwp)
	if labels, _ := s.db.ComicLabels(id, uid); labels != nil {
		resp.Labels = labels
	}
	if collsByID, _ := s.db.CollectionsForComics(uid, []int64{id}); collsByID[id] != nil {
		resp.Collections = collsByID[id]
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleGetCover(w http.ResponseWriter, r *http.Request) {
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
	if c.CoverPath == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, c.CoverPath)
}

// parseCSVInts splits "3,7,12" into [3,7,12] for multi-filter query params.
// Empty input or unparseable elements yield an empty (or shorter) slice.
func parseCSVInts(s string) []int64 {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if n, err := strconv.ParseInt(p, 10, 64); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// Quantise the requested viewport width to a small set of buckets so the cache
// gets repeated hits across slightly different screen widths instead of one
// entry per browser pixel. ~50px granularity is invisible visually but lets
// every 1920px-ish desktop share a single cached pixmap.
func bucketedWidth(w int) int {
	if w <= 0 {
		return 0
	}
	const bucket = 50
	q := ((w + bucket - 1) / bucket) * bucket
	if q < 100 {
		q = 100
	}
	if q > 3000 {
		q = 3000
	}
	return q
}

func (s *server) handleGetPage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	n, err := strconv.Atoi(chi.URLParam(r, "n"))
	if err != nil || n < 1 {
		writeError(w, http.StatusBadRequest, "invalid page number")
		return
	}

	c, err := s.db.GetComicByID(id)
	if err != nil || c == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Fast path: resized request served from disk cache. The cache key
	// includes the source file's mtime so a re-scanned / replaced file
	// naturally bypasses stale entries.
	var targetWidth int
	if ws := r.URL.Query().Get("width"); ws != "" {
		if tw, err := strconv.Atoi(ws); err == nil {
			targetWidth = bucketedWidth(tw)
		}
	}
	var cachePath string
	if targetWidth > 0 {
		mtime := c.FileMtime.Unix()
		cacheDir := filepath.Join(s.cfg.DataDir, "page_cache", strconv.FormatInt(id, 10))
		cachePath = filepath.Join(cacheDir, fmt.Sprintf("%d_%d_%d.jpg", n, targetWidth, mtime))
		if _, err := os.Stat(cachePath); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, cachePath)
			return
		}
	}

	ext := "." + strings.ToLower(c.Format)
	rd := reader.For(ext)
	if rd == nil {
		writeError(w, http.StatusUnsupportedMediaType, "format not supported for page serving")
		return
	}
	if err := rd.Open(c.Path); err != nil {
		writeError(w, http.StatusInternalServerError, "could not open comic")
		return
	}
	defer rd.Close()

	rc, mimeType, err := rd.Page(n - 1) // API is 1-indexed
	if err != nil {
		writeError(w, http.StatusNotFound, "page not found")
		return
	}
	defer rc.Close()

	if targetWidth > 0 {
		if img, _, err := image.Decode(rc); err == nil {
			resized := imaging.Resize(img, targetWidth, 0, imaging.Lanczos)
			var buf bytes.Buffer
			if err := imaging.Encode(&buf, resized, imaging.JPEG, imaging.JPEGQuality(85)); err == nil {
				// Write to a temp file then rename so concurrent readers never
				// see a partial JPEG. Cache misses on disk-full are silently
				// ignored — we still serve the in-memory result.
				if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err == nil {
					tmp := cachePath + ".tmp"
					if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err == nil {
						os.Rename(tmp, cachePath)
					}
				}
				w.Header().Set("Content-Type", "image/jpeg")
				w.Header().Set("Cache-Control", "public, max-age=86400")
				w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
				w.Write(buf.Bytes())
				return
			}
		}
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.Copy(w, rc)
}

func (s *server) handleGetFile(w http.ResponseWriter, r *http.Request) {
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
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeFile(w, r, c.Path)
}

func (s *server) handleGetProgress(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	p, err := s.db.GetProgress(getClaims(r).UserID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	if p == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, progressResp{
		LastPage:  p.LastPage,
		LastCFI:   p.LastCFI,
		UpdatedAt: p.UpdatedAt.Format(time.RFC3339),
	})
}

func (s *server) handlePostProgress(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		LastPage int    `json:"last_page"`
		LastCFI  string `json:"last_cfi"`
		Seq      int64  `json:"seq"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.db.UpsertProgress(getClaims(r).UserID, id, body.LastPage, body.LastCFI, body.Seq); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save progress")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSetPageCount lets the client (PDF or ePub reader) backfill page_count
// for formats the scanner can't enumerate server-side. PDFs report their real
// numPages once pdf.js opens the doc; ePubs report 100 so the existing pct
// formula (last_page / page_count * 100) doubles as a percentage display in
// the library card. Any logged-in user can hit it — the value is a property
// of the file, not the user.
func (s *server) handleSetPageCount(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		PageCount int `json:"page_count"`
	}
	if err := decode(r, &body); err != nil || body.PageCount <= 0 {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, err := s.db.SetComicPageCount(id, body.PageCount); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update page count")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleSetCover(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var body struct {
		Page int `json:"page"`
	}
	if err := decode(r, &body); err != nil || body.Page < 1 {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}

	c, err := s.db.GetComicByID(id)
	if err != nil || c == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if c.Format == "pdf" {
		writeError(w, http.StatusBadRequest, "pdf covers not supported")
		return
	}

	ext := "." + strings.ToLower(c.Format)
	rd := reader.For(ext)
	if rd == nil {
		writeError(w, http.StatusUnsupportedMediaType, "format not supported")
		return
	}
	if err := rd.Open(c.Path); err != nil {
		writeError(w, http.StatusInternalServerError, "could not open comic")
		return
	}
	defer rd.Close()

	rc, _, err := rd.Page(body.Page - 1)
	if err != nil {
		writeError(w, http.StatusNotFound, "page not found")
		return
	}
	defer rc.Close()

	img, _, err := image.Decode(rc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not decode image")
		return
	}

	coverPath := filepath.Join(s.cfg.DataDir, "covers", fmt.Sprintf("%d.jpg", id))
	thumb := imaging.Resize(img, 300, 0, imaging.Lanczos)
	if err := imaging.Save(thumb, coverPath); err != nil {
		log.Printf("api: save cover %s: %v", coverPath, err)
		writeError(w, http.StatusInternalServerError, "could not save cover")
		return
	}

	if err := s.db.SetCustomCover(id, coverPath); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update cover")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleUploadCover(w http.ResponseWriter, r *http.Request) {
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

	img, _, err := image.Decode(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not decode image")
		return
	}

	coverPath := filepath.Join(s.cfg.DataDir, "covers", fmt.Sprintf("%d.jpg", id))
	thumb := imaging.Resize(img, 300, 0, imaging.Lanczos)
	if err := imaging.Save(thumb, coverPath); err != nil {
		log.Printf("api: save cover %s: %v", coverPath, err)
		writeError(w, http.StatusInternalServerError, "could not save cover")
		return
	}
	if err := s.db.SetCustomCover(id, coverPath); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update cover")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleClearCover(w http.ResponseWriter, r *http.Request) {
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

	coverPath := filepath.Join(s.cfg.DataDir, "covers", fmt.Sprintf("%d.jpg", id))

	// For formats we can extract pages from, immediately regenerate the auto-cover
	// from page 1 so the library doesn't show a broken image after a clear.
	// PDFs can't be rendered server-side, so we just remove the custom file.
	if c.Format != "pdf" {
		ext := "." + strings.ToLower(c.Format)
		if rd := reader.For(ext); rd != nil {
			if err := rd.Open(c.Path); err == nil {
				if rc, _, err := rd.Page(0); err == nil {
					if img, _, err := image.Decode(rc); err == nil {
						thumb := imaging.Resize(img, 300, 0, imaging.Lanczos)
						_ = imaging.Save(thumb, coverPath)
					}
					rc.Close()
				}
				rd.Close()
			}
		}
		if err := s.db.SetAutoCover(id, coverPath); err != nil {
			writeError(w, http.StatusInternalServerError, "could not clear cover")
			return
		}
	} else {
		if c.CoverPath != "" {
			os.Remove(c.CoverPath)
		}
		if err := s.db.ClearCustomCover(id); err != nil {
			writeError(w, http.StatusInternalServerError, "could not clear cover")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

