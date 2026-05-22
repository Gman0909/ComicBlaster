package scanner

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/disintegration/imaging"

	"comicblaster/internal/reader"
	"comicblaster/internal/storage"
)

type Scanner struct {
	db        *storage.DB
	coversDir string

	mu       sync.Mutex
	scanning bool
	status   Status
}

type Status struct {
	Running   bool   `json:"running"`
	Processed int    `json:"processed"`
	Current   string `json:"current,omitempty"`
	LastScan  string `json:"last_scan,omitempty"`
	LastCount int    `json:"last_count"`
}

func New(db *storage.DB, coversDir string) *Scanner {
	return &Scanner{db: db, coversDir: coversDir}
}

func (s *Scanner) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Scanner) Scan() {
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return
	}
	s.scanning = true
	s.status.Running = true
	s.status.Processed = 0
	s.status.Current = ""
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		count := s.status.Processed
		s.scanning = false
		s.status.Running = false
		s.status.Current = ""
		s.status.LastScan = time.Now().Format(time.RFC3339)
		s.status.LastCount = count
		s.mu.Unlock()
	}()

	paths, err := s.db.AllLibraryPaths()
	if err != nil {
		log.Printf("scanner: could not read paths: %v", err)
		return
	}
	ignored, _ := s.db.IgnoredPathSet()

	log.Printf("scanner: scan started (%d paths, %d ignored)", len(paths), len(ignored))
	found := map[string]bool{}

	// Per-root outcome. A root counts as "scanned successfully" only if
	// we could ReadDir it AND it returned at least one entry. The
	// existence of the missing-flag clock means a temporary outage
	// (CIFS mount goes stale, NAS reboots, etc.) leaves user state
	// untouched: comics under an unscannable root are skipped entirely
	// in the sweep below, neither marked missing nor deleted.
	//
	// os.Stat alone is not enough — a stale CIFS mountpoint inode
	// satisfies Stat without the kernel ever talking to the NAS. The
	// observed failure mode: filepath.WalkDir silently returns zero
	// entries, the original code interpreted that as "all comics
	// deleted", and the FK CASCADE wiped every reading_progress /
	// comic_labels / collection_comics row in the DB.
	type rootResult struct {
		path string
		ok   bool // true iff we trust this root's "missing" inference
	}
	results := make([]rootResult, 0, len(paths))

	for _, root := range paths {
		entries, derr := os.ReadDir(root)
		if derr != nil {
			log.Printf("scanner: skip root %s (readdir: %v)", root, derr)
			results = append(results, rootResult{path: root, ok: false})
			continue
		}
		if len(entries) == 0 {
			// Could be a legit empty library OR a stale mount that
			// reads as empty. Either way: don't trust this scan to
			// imply existing comics are missing.
			log.Printf("scanner: skip root %s (empty — treating as unavailable for missing-sweep)", root)
			results = append(results, rootResult{path: root, ok: false})
			continue
		}

		filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if ignored[path] {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if reader.For(ext) == nil {
				return nil
			}
			found[path] = true
			s.mu.Lock()
			s.status.Current = filepath.Base(path)
			s.status.Processed++
			s.mu.Unlock()
			s.processFile(path)
			return nil
		})
		results = append(results, rootResult{path: root, ok: true})
	}

	// Missing sweep. Only acts on comics whose root scanned OK; for
	// roots that failed (mount stale, dir empty, etc.) we deliberately
	// do nothing — better to leave a stale row than wipe user state.
	//
	// The scanner NEVER hard-deletes missing files. It only sets /
	// clears the missing_since flag. Purging is a manual admin action
	// surfaced via Settings → Missing files; that's where the bulk
	// confirmation dialog and the per-file accountability live.
	existing, _ := s.db.AllComicPathsWithMissing()
	now := time.Now().UTC()

	underRoot := func(path string) bool {
		for _, r := range results {
			if !r.ok {
				continue
			}
			if path == r.path || strings.HasPrefix(path, r.path+string(filepath.Separator)) {
				return true
			}
		}
		return false
	}

	for path, missingSince := range existing {
		if found[path] {
			if missingSince != nil {
				log.Printf("scanner: %s back from missing", path)
				s.db.ClearMissing(path)
			}
			continue
		}
		if !underRoot(path) {
			continue
		}
		if missingSince == nil {
			log.Printf("scanner: marking missing %s", path)
			s.db.MarkMissing(path, now)
		}
		// else: still missing; nothing to do — the user removes
		// these via Settings → Missing files.
	}

	log.Printf("scanner: scan complete (%d comics observed)", len(found))
}

func (s *Scanner) Watch(intervalSecs int) {
	ticker := time.NewTicker(time.Duration(intervalSecs) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		go s.Scan()
	}
}

func (s *Scanner) processFile(path string) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}

	existing, _ := s.db.GetComicByPath(path)
	if existing != nil && existing.FileMtime.Equal(info.ModTime().UTC()) {
		return // unchanged
	}

	ext := strings.ToLower(filepath.Ext(path))
	r := reader.For(ext)
	if err := r.Open(path); err != nil {
		log.Printf("scanner: open %s: %v", path, err)
		return
	}
	defer r.Close()

	comic := &storage.Comic{
		Path:      path,
		Format:    strings.TrimPrefix(ext, "."),
		PageCount: r.PageCount(),
		FileSize:  info.Size(),
		FileMtime: info.ModTime().UTC(),
	}

	if ext == ".cbz" || ext == ".zip" {
		comic.Title, comic.Series, comic.Volume, comic.Issue = extractComicInfoXML(path)
	}
	// ePub readers expose a Title() method via the manifest metadata
	if ext == ".epub" {
		if er, ok := r.(interface{ Title() string }); ok {
			if t := er.Title(); t != "" {
				comic.Title = t
			}
		}
	}
	if comic.Title == "" {
		comic.Title, comic.Series, comic.Volume, comic.Issue = parseFilename(filepath.Base(path))
	}

	id, err := s.db.UpsertComic(comic)
	if err != nil {
		log.Printf("scanner: upsert %s: %v", path, err)
		return
	}

	// Never overwrite a user-chosen custom thumbnail
	if existing != nil && existing.CustomCover {
		return
	}

	coverPath := filepath.Join(s.coversDir, fmt.Sprintf("%d.jpg", id))
	if _, err := os.Stat(coverPath); os.IsNotExist(err) {
		rc, _, err := r.Page(0)
		if err == nil {
			saveCover(rc, coverPath)
			rc.Close()
			s.db.UpdateCoverPath(id, coverPath)
		}
	}
}

// --- metadata ---

type comicInfoXML struct {
	Title  string  `xml:"Title"`
	Series string  `xml:"Series"`
	Volume int     `xml:"Volume"`
	Number float64 `xml:"Number"`
}

func extractComicInfoXML(path string) (title, series string, volume *int, issue *float64) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return
	}
	defer zr.Close()

	for _, f := range zr.File {
		if strings.ToLower(filepath.Base(f.Name)) != "comicinfo.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return
		}
		var ci comicInfoXML
		if err := xml.Unmarshal(data, &ci); err != nil {
			return
		}
		if ci.Volume != 0 {
			v := ci.Volume
			volume = &v
		}
		if ci.Number != 0 {
			n := ci.Number
			issue = &n
		}
		return ci.Title, ci.Series, volume, issue
	}
	return
}

var (
	reIssue        = regexp.MustCompile(`#(\d+(?:\.\d+)?)`)
	reVolume       = regexp.MustCompile(`(?i)\bv(?:ol(?:ume)?)?\.?\s*(\d+)\b`)
	reYear         = regexp.MustCompile(`\(\d{4}\)`)
	reLeadingDigit = regexp.MustCompile(`^(\d+(?:\.\d+)?)`)
)

func parseFilename(name string) (title, series string, volume *int, issue *float64) {
	name = strings.TrimSuffix(name, filepath.Ext(name))

	// ComicRack format: Series_Name~NNN-_Subtitle
	if idx := strings.Index(name, "~"); idx != -1 {
		series = strings.TrimSpace(strings.ReplaceAll(name[:idx], "_", " "))
		rest := name[idx+1:]
		if m := reLeadingDigit.FindStringSubmatch(rest); m != nil {
			if n, err := strconv.ParseFloat(m[1], 64); err == nil {
				issue = &n
			}
			sub := strings.TrimSpace(strings.ReplaceAll(strings.TrimLeft(rest[len(m[1]):], "-_"), "_", " "))
			if sub != "" {
				title = sub
			} else {
				title = fmt.Sprintf("%s #%g", series, *issue)
			}
		} else {
			title = series
		}
		return
	}

	// Standard format — underscores become spaces as baseline
	title = strings.TrimSpace(strings.ReplaceAll(name, "_", " "))

	// Extract issue number (#NNN)
	if m := reIssue.FindStringSubmatchIndex(name); m != nil {
		if n, err := strconv.ParseFloat(name[m[2]:m[3]], 64); err == nil {
			issue = &n
		}
		series = strings.TrimRight(strings.TrimSpace(name[:m[0]]), " -")
	}

	// Extract volume
	if m := reVolume.FindStringSubmatchIndex(name); m != nil {
		if n, err := strconv.Atoi(name[m[2]:m[3]]); err == nil {
			volume = &n
		}
		if series == "" {
			series = strings.TrimRight(strings.TrimSpace(name[:m[0]]), " -")
		}
	}

	if series != "" {
		series = strings.TrimSpace(strings.ReplaceAll(reYear.ReplaceAllString(series, ""), "_", " "))
		title = series
		if issue != nil {
			title += fmt.Sprintf(" #%g", *issue)
		}
	}
	return
}

// --- cover extraction ---

func saveCover(r io.Reader, destPath string) {
	img, _, err := image.Decode(r)
	if err != nil {
		return
	}
	// Resize to 300px wide, maintain aspect ratio
	thumb := imaging.Resize(img, 300, 0, imaging.Lanczos)
	if err := imaging.Save(thumb, destPath); err != nil {
		log.Printf("scanner: save cover %s: %v", destPath, err)
	}
}
