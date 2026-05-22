package api

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Admin-only filesystem browser used by Settings → Library paths.
//
// The server is the authoritative view of "what folders does this
// machine have?" — a native folder picker on the client wouldn't help
// when client + server live on different machines (Windows client,
// Pi server). These endpoints let the client navigate the SERVER's
// filesystem to pick a path that's valid on the server.
//
// Both handlers sit behind requireAdmin. The existing "Add path" text
// input already trusts admins to type any absolute path; this just
// makes that trust visible.

type browseEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
}

type browseResp struct {
	Path      string        `json:"path"`               // canonicalised current directory
	Separator string        `json:"separator"`          // "/" or "\\" — the server's native one
	Parent    string        `json:"parent,omitempty"`   // absent at filesystem root
	Entries   []browseEntry `json:"entries"`            // sub-directories of Path; sorted, lower-case-insensitive
	Roots     []string      `json:"roots,omitempty"`    // top-level mount points (Windows drive letters; "/" on POSIX)
}

// handleBrowse — GET /api/admin/browse?path=<dir>
//
// If path is empty or doesn't exist, falls back to the service user's
// home directory; if even that fails, to the filesystem root. Returns
// directories only (no files), with symlinks resolved.
func (s *server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	resolved, err := resolveStart(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries, err := readDirs(resolved)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read directory: "+err.Error())
		return
	}
	resp := browseResp{
		Path:      resolved,
		Separator: string(os.PathSeparator),
		Entries:   entries,
		Roots:     filesystemRoots(),
	}
	parent := filepath.Dir(resolved)
	if parent != resolved {
		resp.Parent = parent
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleMkdir — POST /api/admin/browse/mkdir  { path, name }
//
// Creates a new directory `name` inside `path`. Returns the resulting
// absolute directory path so the client can navigate into it. Name is
// validated server-side: no separators (so users can't sneak a nested
// path through the form), no '..', non-empty.
func (s *server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		writeError(w, http.StatusBadRequest, "name must be a single folder name (no separators)")
		return
	}
	if body.Path == "" {
		writeError(w, http.StatusBadRequest, "parent path required")
		return
	}
	parent, err := resolveStart(body.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	target := filepath.Join(parent, name)
	if err := os.Mkdir(target, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": target})
}

// resolveStart picks the directory the browse should land on.
//
//   - Explicit path that exists and is a directory  → use it (cleaned).
//   - Empty / missing / not-a-directory             → fall back to the
//     service user's home dir, then to the filesystem root.
//
// Returns a cleaned, absolute path. Errors only if even the root is
// unreadable, which shouldn't happen on a sane host.
func resolveStart(path string) (string, error) {
	if path != "" {
		clean := filepath.Clean(path)
		if abs, err := filepath.Abs(clean); err == nil {
			if info, err := os.Stat(abs); err == nil && info.IsDir() {
				return abs, nil
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if info, err := os.Stat(home); err == nil && info.IsDir() {
			return home, nil
		}
	}
	if runtime.GOOS == "windows" {
		// C:\ is a reasonable Windows fallback.
		if info, err := os.Stat(`C:\`); err == nil && info.IsDir() {
			return `C:\`, nil
		}
	}
	if info, err := os.Stat("/"); err == nil && info.IsDir() {
		return "/", nil
	}
	return "", os.ErrNotExist
}

// readDirs lists the subdirectories of dir. Files are skipped. Entries
// starting with '.' are kept (the user might want to add ~/comics or
// /mnt/.snapshots) — we don't second-guess the admin.
func readDirs(dir string) ([]browseEntry, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	var out []browseEntry
	for _, n := range names {
		full := filepath.Join(dir, n)
		info, err := os.Stat(full) // Stat follows symlinks so a link → dir shows up
		if err != nil || !info.IsDir() {
			continue
		}
		out = append(out, browseEntry{Name: n, Path: full, IsDir: true})
	}
	// Case-insensitive sort so 'apple' sits next to 'Banana' the way a
	// human would expect rather than the way ASCII sort would.
	sortEntriesCI(out)
	return out, nil
}

func sortEntriesCI(s []browseEntry) {
	for i := 1; i < len(s); i++ {
		j := i
		for j > 0 && strings.ToLower(s[j-1].Name) > strings.ToLower(s[j].Name) {
			s[j-1], s[j] = s[j], s[j-1]
			j--
		}
	}
}

// filesystemRoots returns top-level mount points the client can jump
// to from anywhere. On Windows, that's the live drive letters; on
// POSIX, just "/" — there's no useful equivalent to a Windows drive
// listing because everything is under the same root.
func filesystemRoots() []string {
	if runtime.GOOS != "windows" {
		return []string{"/"}
	}
	var out []string
	for c := 'A'; c <= 'Z'; c++ {
		root := string(c) + `:\`
		if _, err := os.Stat(root); err == nil {
			out = append(out, root)
		}
	}
	return out
}
