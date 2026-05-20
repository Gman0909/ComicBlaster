package reader

import (
	"bytes"
	"database/sql"
	"io"

	_ "modernc.org/sqlite"
)

// cbiReader reads ComicRack's SQLite-based .cbi format.
// Schema: comics(title, page_count), pages(comic_title, page_number, image BLOB)
func init() {
	Register(".cbi", func() FormatReader { return &cbiReader{} })
}

type cbiReader struct {
	db        *sql.DB
	title     string
	pageCount int
}

func (r *cbiReader) Open(path string) error {
	db, err := sql.Open("sqlite", path+"?mode=ro")
	if err != nil {
		return err
	}
	if err := db.QueryRow(`SELECT title, page_count FROM comics LIMIT 1`).
		Scan(&r.title, &r.pageCount); err != nil {
		db.Close()
		return err
	}
	r.db = db
	return nil
}

func (r *cbiReader) PageCount() int { return r.pageCount }

func (r *cbiReader) Page(n int) (io.ReadCloser, string, error) {
	var data []byte
	err := r.db.QueryRow(
		`SELECT image FROM pages WHERE comic_title = ? AND page_number = ?`,
		r.title, n+1, // pages table is 1-indexed
	).Scan(&data)
	if err != nil {
		return nil, "", err
	}
	return io.NopCloser(bytes.NewReader(data)), "image/jpeg", nil
}

func (r *cbiReader) Close() error {
	if r.db != nil {
		return r.db.Close()
	}
	return nil
}
