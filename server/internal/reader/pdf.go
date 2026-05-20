package reader

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
)

func init() {
	Register(".pdf", func() FormatReader { return &pdfReader{} })
}

type pdfReader struct {
	count int
}

func (r *pdfReader) Open(path string) error {
	n, err := pdfPageCount(path)
	if err != nil {
		return err
	}
	r.count = n
	return nil
}

func (r *pdfReader) PageCount() int { return r.count }

// Page is not used for PDFs — rendering is handled client-side via pdf.js.
func (r *pdfReader) Page(_ int) (io.ReadCloser, string, error) {
	return nil, "", fmt.Errorf("pdf: pages rendered client-side")
}

func (r *pdfReader) Close() error { return nil }

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
