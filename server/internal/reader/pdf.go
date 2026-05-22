package reader

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func init() {
	Register(".pdf", func() FormatReader { return &pdfReader{} })
}

type pdfReader struct {
	path  string
	count int
}

func (r *pdfReader) Open(path string) error {
	n, err := pdfPageCount(path)
	if err != nil {
		return err
	}
	r.path = path
	r.count = n
	return nil
}

func (r *pdfReader) PageCount() int { return r.count }

// Page rasterises a single PDF page to JPEG via pdftocairo (part of
// the poppler-utils package, typically installed on Linux/macOS).
// Used by the scanner to extract a cover thumbnail at scan time —
// the actual reader UI renders PDFs client-side via pdf.js and
// doesn't call this.
//
// Returns a ReadCloser whose Close() deletes the underlying temp
// file, so callers don't have to do their own cleanup. If
// pdftocairo isn't installed (Windows, minimal containers) the
// scanner sees the error, skips, and the comic gets no
// auto-generated cover — the existing manual "Set thumbnail"
// flow in the library still works.
func (r *pdfReader) Page(n int) (io.ReadCloser, string, error) {
	if r.path == "" {
		return nil, "", fmt.Errorf("pdf reader not initialised")
	}
	// pdftocairo uses 1-based page numbers; our API is 0-based.
	page := n + 1

	// Create a temp file path; pdftocairo with -singlefile appends
	// .jpg to the given prefix and won't overwrite an existing one
	// in a race-free way, so we generate a unique prefix and remove
	// the file we created (we just want the path reserved).
	tmp, err := os.CreateTemp("", "cb-pdf-cover-*.jpg")
	if err != nil {
		return nil, "", err
	}
	tmp.Close()
	os.Remove(tmp.Name())
	prefix := strings.TrimSuffix(tmp.Name(), filepath.Ext(tmp.Name()))
	outPath := prefix + ".jpg"

	cmd := exec.Command("pdftocairo",
		"-jpeg",
		"-f", strconv.Itoa(page),
		"-l", strconv.Itoa(page),
		"-singlefile",
		// Cap the long side at 800px — the scanner downsizes to 300
		// when saving the cover anyway; this just keeps the
		// intermediate JPEG small/fast to produce.
		"-scale-to", "800",
		r.path,
		prefix,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		os.Remove(outPath)
		return nil, "", fmt.Errorf("pdftocairo failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	f, err := os.Open(outPath)
	if err != nil {
		return nil, "", err
	}
	return &tempFileCloser{File: f, path: outPath}, "image/jpeg", nil
}

func (r *pdfReader) Close() error { return nil }

// tempFileCloser owns an underlying tempfile and removes it on Close.
type tempFileCloser struct {
	*os.File
	path string
}

func (t *tempFileCloser) Close() error {
	err := t.File.Close()
	os.Remove(t.path)
	return err
}

// pdfPageCount extracts the total page count from a PDF without heavy
// dependencies. It searches for /Count N entries in the raw file bytes;
// the root /Pages dictionary always contains the largest value.
// Works for most PDFs where the page tree is not inside a compressed stream.
func pdfPageCount(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// Read at most the first 512 KB + last 512 KB to keep memory bounded.
	const half = 512 << 10
	stat, _ := f.Stat()
	size := stat.Size()

	var data []byte
	if size <= 2*half {
		data, err = io.ReadAll(f)
	} else {
		head := make([]byte, half)
		n, _ := f.Read(head)
		data = head[:n]
		tail := make([]byte, half)
		if _, e := f.Seek(-half, io.SeekEnd); e == nil {
			n, _ = f.Read(tail)
			data = append(data, tail[:n]...)
		}
	}
	if err != nil {
		return 0, err
	}

	re := regexp.MustCompile(`/Count\s+(\d+)`)
	max := 0
	for _, m := range re.FindAllSubmatch(data, -1) {
		if n, e := strconv.Atoi(string(m[1])); e == nil && n > max {
			max = n
		}
	}
	if max > 0 {
		return max, nil
	}
	// Return 0; the client (pdf.js) will determine the actual page count.
	return 0, nil
}
