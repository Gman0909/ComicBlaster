// Per-page extraction for locally-stored comic archives. This is the
// Wails-side counterpart to the server's /api/comics/{id}/pages/{n}
// endpoint — Reader.tsx uses it when the comic has been downloaded
// for offline reading, so individual page images can be served from
// the local archive without a network round-trip.
//
// CBZ (zip) is the common case; CBR (rar) is supported via the same
// rardecode library the server uses. PDFs don't need per-page
// extraction because pdf.js reads them whole-file from /_offline/{id}.
//
// The logic deliberately mirrors server/internal/reader/{cbz,cbr}.go
// — natural sort of image entries, only common image extensions
// (.jpg/.jpeg/.png/.gif/.webp), skip hidden ".thumbs" / Mac OS
// metadata. Code is duplicated rather than shared because client/
// and server/ are separate Go modules; the surface is small enough
// that this is the lower-friction choice.

package offline

import (
	"archive/zip"
	"bytes"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nwaples/rardecode"
)

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true,
	".gif": true, ".webp": true,
}

// ServePage writes the Nth image inside the local archive for
// `comicID` to `w`. Sets Content-Type from the file extension. Used
// by spa.go to handle /_offline/{id}/pages/{n}.
func (m *Manager) ServePage(w http.ResponseWriter, r *http.Request, comicID int64, pageN int) {
	m.mu.Lock()
	var entry *Entry
	for i := range m.manifest {
		if m.manifest[i].ComicID == comicID {
			entry = &m.manifest[i]
			break
		}
	}
	m.mu.Unlock()
	if entry == nil {
		http.NotFound(w, r)
		return
	}
	filePath := filepath.Join(m.filesDir, downloadFilename(comicID, entry.Format))

	switch strings.ToLower(entry.Format) {
	case "cbz", "zip":
		servePageCBZ(w, r, filePath, pageN)
	case "cbr", "rar":
		servePageCBR(w, r, filePath, pageN)
	default:
		// PDFs / ePubs / anything else doesn't use per-page
		// extraction — the reader fetches the whole file via the
		// plain /_offline/{id} path instead.
		http.Error(w, "per-page extraction not supported for this format", http.StatusBadRequest)
	}
}

func servePageCBZ(w http.ResponseWriter, r *http.Request, path string, pageN int) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer zr.Close()

	pages := make([]*zip.File, 0, len(zr.File))
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(f.Name))
		base := strings.ToLower(filepath.Base(f.Name))
		if imageExts[ext] && !strings.HasPrefix(base, ".") {
			pages = append(pages, f)
		}
	}
	sort.Slice(pages, func(i, j int) bool {
		return naturalLess(pages[i].Name, pages[j].Name)
	})
	if pageN < 0 || pageN >= len(pages) {
		http.NotFound(w, r)
		return
	}
	rc, err := pages[pageN].Open()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writePageResponse(w, pages[pageN].Name, data)
}

func servePageCBR(w http.ResponseWriter, r *http.Request, path string, pageN int) {
	// Two-pass: first enumerate to find the Nth image's name (RAR
	// is stream-only — we can't seek randomly), then re-open and
	// stream until we reach it. Same approach as the server's
	// cbrReader.
	names, err := cbrImageNames(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if pageN < 0 || pageN >= len(names) {
		http.NotFound(w, r)
		return
	}
	target := names[pageN]

	ar, err := rardecode.OpenReader(path, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer ar.Close()
	for {
		hdr, err := ar.Next()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if hdr.Name != target {
			continue
		}
		data, err := io.ReadAll(ar)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writePageResponse(w, target, data)
		return
	}
}

func cbrImageNames(path string) ([]string, error) {
	ar, err := rardecode.OpenReader(path, "")
	if err != nil {
		return nil, err
	}
	defer ar.Close()
	var names []string
	for {
		hdr, err := ar.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.IsDir {
			continue
		}
		ext := strings.ToLower(filepath.Ext(hdr.Name))
		base := strings.ToLower(filepath.Base(hdr.Name))
		if imageExts[ext] && !strings.HasPrefix(base, ".") {
			names = append(names, hdr.Name)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return naturalLess(names[i], names[j])
	})
	return names, nil
}

func writePageResponse(w http.ResponseWriter, name string, data []byte) {
	mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if mt == "" {
		mt = "image/jpeg"
	}
	w.Header().Set("Content-Type", mt)
	// Reader code is the only consumer and it doesn't care about
	// strong caching, but a small max-age stops the webview from
	// re-fetching the same image on every render during paged
	// navigation.
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Write(data)
	_ = bytes.NewReader // keep bytes import live; future helpers may use it
}

// naturalLess sorts strings so that numeric runs are compared by
// value. "page2.jpg" < "page10.jpg" rather than the other way around.
// Identical to the server's implementation.
func naturalLess(a, b string) bool {
	for i, j := 0, 0; i < len(a) && j < len(b); {
		ac, bc := a[i], b[j]
		if isDigit(ac) && isDigit(bc) {
			ai, bi := i, j
			for ai < len(a) && a[ai] == '0' {
				ai++
			}
			for bi < len(b) && b[bi] == '0' {
				bi++
			}
			ae, be := ai, bi
			for ae < len(a) && isDigit(a[ae]) {
				ae++
			}
			for be < len(b) && isDigit(b[be]) {
				be++
			}
			la, lb := ae-ai, be-bi
			if la != lb {
				return la < lb
			}
			if a[ai:ae] != b[bi:be] {
				return a[ai:ae] < b[bi:be]
			}
			i, j = ae, be
		} else {
			if ac != bc {
				return ac < bc
			}
			i++
			j++
		}
	}
	return len(a) < len(b)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
