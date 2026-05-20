package reader

import (
	"bytes"
	"io"
	"mime"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nwaples/rardecode"
)

func init() {
	Register(".cbr", func() FormatReader { return &cbrReader{} })
}

type cbrReader struct {
	path  string
	pages []string // sorted image entry names inside the RAR
}

func (r *cbrReader) Open(path string) error {
	ar, err := rardecode.OpenReader(path, "")
	if err != nil {
		return err
	}
	defer ar.Close()

	var pages []string
	for {
		hdr, err := ar.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.IsDir {
			continue
		}
		ext := strings.ToLower(filepath.Ext(hdr.Name))
		base := strings.ToLower(filepath.Base(hdr.Name))
		if imageExts[ext] && !strings.HasPrefix(base, ".") {
			pages = append(pages, hdr.Name)
		}
	}
	sort.Slice(pages, func(i, j int) bool {
		return naturalLess(pages[i], pages[j])
	})
	r.path = path
	r.pages = pages
	return nil
}

func (r *cbrReader) PageCount() int { return len(r.pages) }

func (r *cbrReader) Page(n int) (io.ReadCloser, string, error) {
	if n < 0 || n >= len(r.pages) {
		return nil, "", io.EOF
	}
	target := r.pages[n]

	ar, err := rardecode.OpenReader(r.path, "")
	if err != nil {
		return nil, "", err
	}
	defer ar.Close()

	for {
		hdr, err := ar.Next()
		if err != nil {
			return nil, "", err
		}
		if hdr.Name != target {
			continue
		}
		data, err := io.ReadAll(ar)
		if err != nil {
			return nil, "", err
		}
		ext := strings.ToLower(filepath.Ext(target))
		mt := mime.TypeByExtension(ext)
		if mt == "" {
			mt = "image/jpeg"
		}
		return io.NopCloser(bytes.NewReader(data)), mt, nil
	}
}

func (r *cbrReader) Close() error { return nil }
