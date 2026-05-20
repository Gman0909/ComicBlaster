package reader

import (
	"archive/zip"
	"bytes"
	"io"
	"mime"
	"path/filepath"
	"sort"
	"strings"
)

func init() {
	Register(".cbz", func() FormatReader { return &cbzReader{} })
	Register(".zip", func() FormatReader { return &cbzReader{} })
}

type cbzReader struct {
	zr    *zip.ReadCloser
	pages []*zip.File
}

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true,
	".gif": true, ".webp": true,
}

func (r *cbzReader) Open(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	r.zr = zr

	var pages []*zip.File
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
	r.pages = pages
	return nil
}

func (r *cbzReader) PageCount() int { return len(r.pages) }

func (r *cbzReader) Page(n int) (io.ReadCloser, string, error) {
	if n < 0 || n >= len(r.pages) {
		return nil, "", io.EOF
	}
	rc, err := r.pages[n].Open()
	if err != nil {
		return nil, "", err
	}
	data, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		return nil, "", err
	}
	ext := strings.ToLower(filepath.Ext(r.pages[n].Name))
	mt := mime.TypeByExtension(ext)
	if mt == "" {
		mt = "image/jpeg"
	}
	return io.NopCloser(bytes.NewReader(data)), mt, nil
}

func (r *cbzReader) Close() error {
	if r.zr != nil {
		return r.zr.Close()
	}
	return nil
}

// naturalLess sorts strings so that numeric runs are compared by value.
// "page2.jpg" < "page10.jpg" rather than "page10.jpg" < "page2.jpg".
func naturalLess(a, b string) bool {
	for i, j := 0, 0; i < len(a) && j < len(b); {
		ac, bc := a[i], b[j]
		if isDigit(ac) && isDigit(bc) {
			// skip leading zeros
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
