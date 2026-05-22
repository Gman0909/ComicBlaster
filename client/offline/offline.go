// Package offline owns the local-storage half of the offline-reading
// feature: the manifest of downloaded comics, the bytes themselves,
// and the queue of progress writes the user made while disconnected.
//
// Storage layout lives under os.UserConfigDir()/ComicBlaster/offline/
// (adjacent to connection.json):
//
//   offline/
//     manifest.json           — catalog of what's downloaded
//     library-cache.json      — last-known library list for offline-mode UI
//     progress-queue.json     — queued saveProgress payloads (Phase F)
//     files/<comic_id>.<ext>  — the actual comic files
//
// Per-(server_url, comic_id) scoping in the manifest means a user
// connected to two ComicBlaster servers gets separate inventories;
// switching servers doesn't surface the wrong device's downloads.
package offline

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Entry is the per-comic record in manifest.json. The cover_blob is a
// base64 JPEG kept small enough (server compresses to 300px wide) to
// inline so the offline library can render thumbnails without a
// second round-trip.
type Entry struct {
	ComicID             int64  `json:"comic_id"`
	ServerURL           string `json:"server_url"`
	Title               string `json:"title"`
	Filename            string `json:"filename"`
	Format              string `json:"format"`
	SizeBytes           int64  `json:"size_bytes"`
	DownloadedAt        string `json:"downloaded_at"`
	FileMtimeAtDownload string `json:"file_mtime_at_download,omitempty"`
	CoverBlob           string `json:"cover_blob,omitempty"` // base64 JPEG, ~5-30 KB typically
}

// Status tracks a single in-flight or completed download. Pushed to
// the frontend via Wails events so the UI can show progress bars
// without polling.
type Status struct {
	ComicID    int64  `json:"comic_id"`
	State      string `json:"state"` // "queued" | "downloading" | "complete" | "error"
	BytesDone  int64  `json:"bytes_done"`
	BytesTotal int64  `json:"bytes_total"`
	Error      string `json:"error,omitempty"`
}

// StorageInfo is what the Settings → Offline section consumes.
type StorageInfo struct {
	TotalBytes  int64   `json:"total_bytes"`
	FreeBytes   int64   `json:"free_bytes"`
	Entries     []Entry `json:"entries"`
	ManifestDir string  `json:"manifest_dir"`
}

// Manager owns the on-disk state and the in-flight download table.
// Safe for concurrent use across the Wails RPC surface.
type Manager struct {
	baseDir      string
	manifestPath string
	filesDir     string

	mu         sync.Mutex
	manifest   []Entry          // in-memory mirror of manifest.json
	inFlight   map[int64]*Status // download state by comic ID
}

// New returns a Manager rooted under the OS standard config dir,
// adjacent to connection.json. Directories are created lazily on
// first write.
func New() *Manager {
	base, err := os.UserConfigDir()
	if err != nil {
		exe, _ := os.Executable()
		base = filepath.Dir(exe)
	}
	root := filepath.Join(base, "ComicBlaster", "offline")
	return &Manager{
		baseDir:      root,
		manifestPath: filepath.Join(root, "manifest.json"),
		filesDir:     filepath.Join(root, "files"),
		inFlight:     map[int64]*Status{},
	}
}

// Load reads the manifest from disk. Idempotent — safe to call
// multiple times; reloads from disk on each call so externally-edited
// manifests (the user deleting files by hand) get picked up.
func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.loadLocked()
}

func (m *Manager) loadLocked() error {
	data, err := os.ReadFile(m.manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		m.manifest = nil
		return nil
	}
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	var entries []Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return fmt.Errorf("parse manifest: %w", err)
	}
	m.manifest = entries
	return nil
}

func (m *Manager) saveLocked() error {
	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	data, err := json.MarshalIndent(m.manifest, "", "  ")
	if err != nil {
		return err
	}
	// Atomic-ish: write to a sibling tempfile, rename over the
	// real path so a crash mid-write can't corrupt the manifest.
	tmp := m.manifestPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write manifest tmp: %w", err)
	}
	if err := os.Rename(tmp, m.manifestPath); err != nil {
		return fmt.Errorf("rename manifest: %w", err)
	}
	return nil
}

// List returns the manifest filtered to entries downloaded from
// `serverURL`. Pass "" to get all entries across servers (Settings
// uses this for the global storage view).
func (m *Manager) List(serverURL string) []Entry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if serverURL == "" {
		// Defensive copy so callers can't mutate our slice.
		out := make([]Entry, len(m.manifest))
		copy(out, m.manifest)
		return out
	}
	want := normalizeServerURL(serverURL)
	out := make([]Entry, 0, len(m.manifest))
	for _, e := range m.manifest {
		if normalizeServerURL(e.ServerURL) == want {
			out = append(out, e)
		}
	}
	return out
}

// FilePath returns the on-disk location of a downloaded comic. Used
// by the asset handler to resolve cb://offline/{id} → /actual/path.
// Returns "" if not in the manifest.
func (m *Manager) FilePath(comicID int64) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.manifest {
		if e.ComicID == comicID {
			return filepath.Join(m.filesDir, downloadFilename(comicID, e.Format))
		}
	}
	return ""
}

// Status returns the live or last-seen state of a download. Nil for
// comics that have never been downloaded.
func (m *Manager) Status(comicID int64) *Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.inFlight[comicID]; ok {
		return s
	}
	for _, e := range m.manifest {
		if e.ComicID == comicID {
			return &Status{
				ComicID:    comicID,
				State:      "complete",
				BytesDone:  e.SizeBytes,
				BytesTotal: e.SizeBytes,
			}
		}
	}
	return nil
}

// DownloadParams carries the per-call data we need from the frontend.
// Passed in instead of stuffed onto the Manager because a single
// Manager outlives many download sessions across many connections.
type DownloadParams struct {
	ComicID   int64
	ServerURL string // base URL of the server, no trailing slash
	Token     string // bearer JWT
	Format    string // file extension without dot ("pdf", "epub", "cbz", ...)
	Title     string // for the manifest entry
	CoverURL  string // optional — relative or absolute URL of the cover image
}

// Download streams /api/comics/{id}/file to disk, writes the
// manifest entry on success, and updates the live Status as it
// goes. `onProgress` is invoked from the I/O goroutine each time
// 1% completes; pass nil to skip. Returns the final Entry on
// success.
func (m *Manager) Download(ctx context.Context, p DownloadParams, onProgress func(*Status)) (*Entry, error) {
	if p.ComicID <= 0 {
		return nil, errors.New("comic_id required")
	}
	if p.ServerURL == "" || p.Token == "" {
		return nil, errors.New("server and token required")
	}

	// Mark queued so the UI shows something before HTTP starts.
	st := &Status{ComicID: p.ComicID, State: "queued"}
	m.mu.Lock()
	m.inFlight[p.ComicID] = st
	m.mu.Unlock()
	if onProgress != nil {
		onProgress(st)
	}

	base := strings.TrimRight(p.ServerURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/comics/"+strconv.FormatInt(p.ComicID, 10)+"/file", nil)
	if err != nil {
		return nil, m.fail(p.ComicID, fmt.Errorf("build request: %w", err), onProgress)
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)

	res, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, m.fail(p.ComicID, fmt.Errorf("download: %w", err), onProgress)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, m.fail(p.ComicID, fmt.Errorf("server returned %d", res.StatusCode), onProgress)
	}

	if err := os.MkdirAll(m.filesDir, 0o755); err != nil {
		return nil, m.fail(p.ComicID, fmt.Errorf("mkdir files: %w", err), onProgress)
	}

	st.State = "downloading"
	st.BytesTotal = res.ContentLength
	if onProgress != nil {
		onProgress(st)
	}

	finalPath := filepath.Join(m.filesDir, downloadFilename(p.ComicID, p.Format))
	tmpPath := finalPath + ".part"
	out, err := os.Create(tmpPath)
	if err != nil {
		return nil, m.fail(p.ComicID, fmt.Errorf("create file: %w", err), onProgress)
	}

	// Stream + report progress at 1% boundaries (or at every 1MB,
	// whichever comes first for files with unknown total size).
	written, err := streamWithProgress(out, res.Body, st, onProgress)
	closeErr := out.Close()
	if err != nil {
		os.Remove(tmpPath)
		return nil, m.fail(p.ComicID, fmt.Errorf("write: %w", err), onProgress)
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return nil, m.fail(p.ComicID, fmt.Errorf("close: %w", closeErr), onProgress)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return nil, m.fail(p.ComicID, fmt.Errorf("rename: %w", err), onProgress)
	}

	// Best-effort cover fetch — failure here doesn't fail the
	// download, the offline library just won't have a thumbnail.
	coverBlob := ""
	if p.CoverURL != "" {
		if blob, err := fetchCoverAsBase64(ctx, p.CoverURL, p.Token, p.ServerURL); err == nil {
			coverBlob = blob
		}
	}

	entry := Entry{
		ComicID:      p.ComicID,
		ServerURL:    normalizeServerURL(p.ServerURL),
		Title:        p.Title,
		Filename:     filepath.Base(finalPath),
		Format:       p.Format,
		SizeBytes:    written,
		DownloadedAt: time.Now().UTC().Format(time.RFC3339),
		CoverBlob:    coverBlob,
	}

	m.mu.Lock()
	// Replace any existing entry for the same (server, comic).
	m.manifest = upsertEntry(m.manifest, entry)
	saveErr := m.saveLocked()
	st.State = "complete"
	st.BytesDone = written
	st.BytesTotal = written
	delete(m.inFlight, p.ComicID)
	m.mu.Unlock()
	if onProgress != nil {
		onProgress(st)
	}
	if saveErr != nil {
		// File is on disk but manifest wasn't persisted — leave the
		// file in place (next call will re-download cheaply if the
		// user retries), but report the failure.
		return nil, fmt.Errorf("save manifest: %w", saveErr)
	}
	return &entry, nil
}

// Remove deletes the file for `comicID` and drops the manifest
// entry. Idempotent — calling on a non-downloaded comic is a no-op.
func (m *Manager) Remove(comicID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var found bool
	var ext string
	keep := m.manifest[:0]
	for _, e := range m.manifest {
		if e.ComicID == comicID {
			found = true
			ext = e.Format
			continue
		}
		keep = append(keep, e)
	}
	if !found {
		return nil
	}
	m.manifest = keep
	if err := m.saveLocked(); err != nil {
		return err
	}
	// Best-effort file unlink. If the manifest is updated but the
	// file delete fails, the user can retry; the next download
	// would re-create the entry anyway.
	_ = os.Remove(filepath.Join(m.filesDir, downloadFilename(comicID, ext)))
	return nil
}

// RemoveAll wipes the manifest for `serverURL` and unlinks every
// file. With serverURL="" wipes EVERYTHING — useful for the "remove
// all" button in Settings.
func (m *Manager) RemoveAll(serverURL string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := normalizeServerURL(serverURL)
	keep := m.manifest[:0]
	doomed := make([]Entry, 0)
	for _, e := range m.manifest {
		if want == "" || normalizeServerURL(e.ServerURL) == want {
			doomed = append(doomed, e)
			continue
		}
		keep = append(keep, e)
	}
	m.manifest = keep
	if err := m.saveLocked(); err != nil {
		return err
	}
	for _, e := range doomed {
		_ = os.Remove(filepath.Join(m.filesDir, downloadFilename(e.ComicID, e.Format)))
	}
	return nil
}

// StorageInfo gathers per-Manager counts + free-disk-space for the
// Settings UI. Pass serverURL="" for the global view.
func (m *Manager) StorageInfo(serverURL string) (*StorageInfo, error) {
	entries := m.List(serverURL)
	var total int64
	for _, e := range entries {
		total += e.SizeBytes
	}
	free := freeDiskSpace(m.baseDir)
	return &StorageInfo{
		TotalBytes:  total,
		FreeBytes:   free,
		Entries:     entries,
		ManifestDir: m.baseDir,
	}, nil
}

// LibraryCacheWrite persists the last-known library list so the
// offline-mode bootstrap (Phase E) can render something on first
// launch without a network. The frontend serialises whatever shape
// it wants; we treat it as opaque bytes.
func (m *Manager) LibraryCacheWrite(serverURL string, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := os.MkdirAll(m.baseDir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(m.baseDir, "library-cache-"+slugServer(serverURL)+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LibraryCacheRead returns the last library cache for `serverURL`
// or (nil, nil) if none exists.
func (m *Manager) LibraryCacheRead(serverURL string) ([]byte, error) {
	path := filepath.Join(m.baseDir, "library-cache-"+slugServer(serverURL)+".json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// --- helpers -----------------------------------------------------------------

func (m *Manager) fail(id int64, cause error, onProgress func(*Status)) error {
	m.mu.Lock()
	st := m.inFlight[id]
	if st != nil {
		st.State = "error"
		st.Error = cause.Error()
	}
	delete(m.inFlight, id)
	m.mu.Unlock()
	if onProgress != nil && st != nil {
		onProgress(st)
	}
	return cause
}

// downloadFilename normalises the per-comic file name on disk. Using
// the numeric ID keeps the layout predictable and means file names
// can't collide on case-insensitive filesystems (Windows / macOS).
func downloadFilename(comicID int64, format string) string {
	if format == "" {
		format = "bin"
	}
	return strconv.FormatInt(comicID, 10) + "." + format
}

// normalizeServerURL strips trailing slashes + lowercases the host so
// "http://Pi.local:8082/" and "http://pi.local:8082" match each other
// in the manifest.
func normalizeServerURL(s string) string {
	s = strings.TrimRight(s, "/")
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	u.Host = strings.ToLower(u.Host)
	return u.String()
}

// slugServer turns a server URL into something safe for a filename:
// "http://pi.local:8082" → "pi.local_8082". Used for the library
// cache so two servers don't share a cache file.
func slugServer(s string) string {
	u, err := url.Parse(s)
	host := s
	if err == nil && u.Host != "" {
		host = u.Host
	}
	host = strings.ToLower(host)
	host = strings.NewReplacer(":", "_", "/", "_", "\\", "_").Replace(host)
	if host == "" {
		host = "default"
	}
	return host
}

func upsertEntry(list []Entry, e Entry) []Entry {
	for i := range list {
		if list[i].ComicID == e.ComicID && normalizeServerURL(list[i].ServerURL) == normalizeServerURL(e.ServerURL) {
			list[i] = e
			return list
		}
	}
	return append(list, e)
}

// streamWithProgress copies r into w, calling onProgress at 1%
// boundaries (or every ~1 MB if total is unknown).
func streamWithProgress(w io.Writer, r io.Reader, st *Status, onProgress func(*Status)) (int64, error) {
	buf := make([]byte, 64<<10) // 64 KB
	var written int64
	const unknownTick = 1 << 20 // 1 MB when total unknown
	lastTick := int64(0)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return written, werr
			}
			written += int64(n)
			st.BytesDone = written
			if onProgress != nil {
				shouldReport := false
				if st.BytesTotal > 0 {
					// 1% of total per tick
					tickSize := st.BytesTotal / 100
					if tickSize == 0 {
						tickSize = 1
					}
					if written-lastTick >= tickSize {
						shouldReport = true
					}
				} else if written-lastTick >= unknownTick {
					shouldReport = true
				}
				if shouldReport {
					lastTick = written
					onProgress(st)
				}
			}
		}
		if err == io.EOF {
			return written, nil
		}
		if err != nil {
			return written, err
		}
	}
}

// fetchCoverAsBase64 grabs the cover image so the offline library
// can render thumbnails without a network. The cover URL may be
// absolute (https://...) or relative (/api/comics/N/cover?v=...);
// in the relative case we resolve against serverURL.
func fetchCoverAsBase64(ctx context.Context, coverURL, token, serverURL string) (string, error) {
	full := coverURL
	if strings.HasPrefix(full, "/") {
		full = strings.TrimRight(serverURL, "/") + full
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("cover returned %d", res.StatusCode)
	}
	// Cap at 200 KB so a misbehaving server can't blow up the
	// manifest. Real covers are typically 5-30 KB.
	const cap = 200 << 10
	data, err := io.ReadAll(io.LimitReader(res.Body, cap+1))
	if err != nil {
		return "", err
	}
	if len(data) > cap {
		return "", errors.New("cover too large")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
