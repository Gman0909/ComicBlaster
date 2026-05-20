package storage

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

// --- model types ---

type Comic struct {
	ID          int64
	Path        string
	Title       string
	Series      string
	Volume      *int
	Issue       *float64
	Format      string
	PageCount   int
	CoverPath   string
	CustomCover bool
	FileSize    int64
	DateAdded   time.Time
	FileMtime   time.Time
}

type ComicWithProgress struct {
	Comic
	LastPage          *int
	LastCFI           *string
	ProgressUpdatedAt *time.Time
}

type User struct {
	ID           int64
	Username     string
	Email        string
	PasswordHash string
	Role         string
	CreatedAt    time.Time
}

type Progress struct {
	LastPage  int
	LastCFI   string
	UpdatedAt time.Time
}

type Label struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type Collection struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
	ComicCount  int       `json:"comic_count"`
	UnreadCount int       `json:"unread_count"`
	PreviewIDs  []int64   `json:"preview_ids"`
}

type LibraryPath struct {
	ID      int64     `json:"id"`
	Path    string    `json:"path"`
	AddedAt time.Time `json:"added_at"`
}

type IgnoredPath struct {
	Path    string    `json:"path"`
	AddedAt time.Time `json:"added_at"`
}

// --- open / migrate ---

func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite: single writer
	if _, err := db.Exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;"); err != nil {
		return nil, err
	}
	d := &DB{db: db}
	return d, d.migrate()
}

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) migrate() error {
	if _, err := d.db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT    UNIQUE NOT NULL,
			email         TEXT    NOT NULL DEFAULT '',
			password_hash TEXT    NOT NULL,
			role          TEXT    NOT NULL DEFAULT 'user',
			created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS comics (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			path         TEXT    UNIQUE NOT NULL,
			title        TEXT    NOT NULL,
			series       TEXT    NOT NULL DEFAULT '',
			volume       INTEGER,
			issue        REAL,
			format       TEXT    NOT NULL,
			page_count   INTEGER NOT NULL DEFAULT 0,
			cover_path   TEXT    NOT NULL DEFAULT '',
			custom_cover INTEGER NOT NULL DEFAULT 0,
			file_size    INTEGER NOT NULL DEFAULT 0,
			date_added   DATETIME DEFAULT CURRENT_TIMESTAMP,
			file_mtime   DATETIME
		);

		CREATE INDEX IF NOT EXISTS idx_comics_title  ON comics(title);
		CREATE INDEX IF NOT EXISTS idx_comics_series ON comics(series);

		CREATE TABLE IF NOT EXISTS reading_progress (
			user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
			comic_id   INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
			last_page  INTEGER NOT NULL DEFAULT 0,
			last_cfi   TEXT    NOT NULL DEFAULT '',
			seq        INTEGER NOT NULL DEFAULT 0,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, comic_id)
		);

		CREATE TABLE IF NOT EXISTS labels (
			id      INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name    TEXT    NOT NULL,
			color   TEXT    NOT NULL DEFAULT '#6366f1',
			UNIQUE (user_id, name)
		);

		CREATE TABLE IF NOT EXISTS comic_labels (
			comic_id INTEGER NOT NULL REFERENCES comics(id)  ON DELETE CASCADE,
			label_id INTEGER NOT NULL REFERENCES labels(id)  ON DELETE CASCADE,
			PRIMARY KEY (comic_id, label_id)
		);

		CREATE TABLE IF NOT EXISTS collections (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name       TEXT    NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (user_id, name)
		);

		CREATE TABLE IF NOT EXISTS collection_comics (
			collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			comic_id      INTEGER NOT NULL REFERENCES comics(id)      ON DELETE CASCADE,
			position      INTEGER NOT NULL DEFAULT 0,
			added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (collection_id, comic_id)
		);

		CREATE INDEX IF NOT EXISTS idx_collection_comics_pos
			ON collection_comics(collection_id, position);

		CREATE TABLE IF NOT EXISTS library_paths (
			id       INTEGER PRIMARY KEY AUTOINCREMENT,
			path     TEXT    NOT NULL UNIQUE,
			added_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS ignored_paths (
			path     TEXT PRIMARY KEY,
			added_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		return err
	}
	// Add custom_cover column to existing databases (ignore error if already exists)
	d.db.Exec(`ALTER TABLE comics ADD COLUMN custom_cover INTEGER NOT NULL DEFAULT 0`)
	// Add last_cfi column for ePub reading position (ignore error if already exists)
	d.db.Exec(`ALTER TABLE reading_progress ADD COLUMN last_cfi TEXT NOT NULL DEFAULT ''`)
	// Add monotonic seq column for ordering concurrent progress writes.
	d.db.Exec(`ALTER TABLE reading_progress ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`)
	return nil
}

// --- users ---

func (d *DB) HasUsers() bool {
	var n int
	d.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n > 0
}

func (d *DB) CreateUser(username, email, passwordHash, role string) (int64, error) {
	res, err := d.db.Exec(
		`INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)`,
		username, email, passwordHash, role,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (d *DB) GetUserByUsername(username string) (*User, error) {
	u := &User{}
	err := d.db.QueryRow(
		`SELECT id, username, email, password_hash, role, created_at FROM users WHERE username = ?`,
		username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

func (d *DB) GetUserByID(id int64) (*User, error) {
	u := &User{}
	err := d.db.QueryRow(
		`SELECT id, username, email, password_hash, role, created_at FROM users WHERE id = ?`,
		id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

func (d *DB) ListUsers() ([]*User, error) {
	rows, err := d.db.Query(
		`SELECT id, username, email, role, created_at FROM users ORDER BY id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (d *DB) DeleteUser(id int64) error {
	_, err := d.db.Exec(`DELETE FROM users WHERE id = ?`, id)
	return err
}

func (d *DB) UpdateUserPassword(id int64, hash string) error {
	_, err := d.db.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
	return err
}

// --- comics ---

func (d *DB) UpsertComic(c *Comic) (int64, error) {
	res, err := d.db.Exec(`
		INSERT INTO comics (path, title, series, volume, issue, format, page_count, file_size, file_mtime)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			title      = excluded.title,
			series     = excluded.series,
			volume     = excluded.volume,
			issue      = excluded.issue,
			format     = excluded.format,
			page_count = excluded.page_count,
			file_size  = excluded.file_size,
			file_mtime = excluded.file_mtime`,
		c.Path, c.Title, c.Series, c.Volume, c.Issue,
		c.Format, c.PageCount, c.FileSize, c.FileMtime,
	)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	if id == 0 {
		d.db.QueryRow(`SELECT id FROM comics WHERE path = ?`, c.Path).Scan(&id)
	}
	return id, nil
}

func (d *DB) UpdateCoverPath(id int64, path string) error {
	_, err := d.db.Exec(`UPDATE comics SET cover_path = ? WHERE id = ?`, path, id)
	return err
}

func (d *DB) GetComicByPath(path string) (*Comic, error) {
	c := &Comic{}
	err := d.db.QueryRow(
		`SELECT id, path, title, series, volume, issue, format, page_count, cover_path, custom_cover, file_size, file_mtime
		 FROM comics WHERE path = ?`, path,
	).Scan(&c.ID, &c.Path, &c.Title, &c.Series, &c.Volume, &c.Issue,
		&c.Format, &c.PageCount, &c.CoverPath, &c.CustomCover, &c.FileSize, &c.FileMtime)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

func (d *DB) GetComicByID(id int64) (*Comic, error) {
	c := &Comic{}
	err := d.db.QueryRow(
		`SELECT id, path, title, series, volume, issue, format, page_count, cover_path, custom_cover, file_size, file_mtime
		 FROM comics WHERE id = ?`, id,
	).Scan(&c.ID, &c.Path, &c.Title, &c.Series, &c.Volume, &c.Issue,
		&c.Format, &c.PageCount, &c.CoverPath, &c.CustomCover, &c.FileSize, &c.FileMtime)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

type ListComicsParams struct {
	UserID        int64
	Search        string
	Sort          string  // title | series | date_added | last_read | position
	Order         string  // asc | desc
	Format        string
	LabelIDs      []int64 // empty = no filter; multiple = comic must have ALL of these
	CollectionIDs []int64 // empty = no filter; multiple = comic must be in ALL of these
	UnreadOnly    bool    // hide comics where last_page >= page_count
	Page          int
	PerPage       int
}

func (d *DB) ListComics(p ListComicsParams) ([]*ComicWithProgress, int, error) {
	if p.PerPage <= 0 {
		p.PerPage = 50
	}
	if p.Page <= 0 {
		p.Page = 1
	}

	sortExpr := "c.title"
	switch p.Sort {
	case "series":
		sortExpr = "c.series, c.volume, c.issue"
	case "date_added":
		sortExpr = "c.date_added"
	case "last_read":
		sortExpr = "COALESCE(rp.updated_at, '1970-01-01')"
	}
	order := "ASC"
	if strings.ToLower(p.Order) == "desc" {
		order = "DESC"
	}

	args := []any{p.UserID}
	where := "WHERE 1=1"
	if p.Search != "" {
		where += " AND (c.title LIKE ? OR c.series LIKE ?)"
		args = append(args, "%"+p.Search+"%", "%"+p.Search+"%")
	}
	if p.Format != "" {
		where += " AND c.format = ?"
		args = append(args, p.Format)
	}
	if p.UnreadOnly {
		// "Unread" = no progress yet, OR progress hasn't reached the last page.
		// PDFs report page_count=0, so anything below that bound is treated as
		// not-yet-read.
		where += ` AND (rp.last_page IS NULL OR c.page_count = 0 OR rp.last_page < c.page_count)`
	}
	// Multi-label AND: every requested label must be attached to the comic.
	for _, lid := range p.LabelIDs {
		if lid <= 0 {
			continue
		}
		where += ` AND c.id IN (
			SELECT cl.comic_id FROM comic_labels cl
			JOIN labels l ON l.id = cl.label_id
			WHERE cl.label_id = ? AND l.user_id = ?
		)`
		args = append(args, lid, p.UserID)
	}
	// Multi-collection AND: the comic must live in every requested collection.
	for _, cid := range p.CollectionIDs {
		if cid <= 0 {
			continue
		}
		where += ` AND c.id IN (
			SELECT cc.comic_id FROM collection_comics cc
			JOIN collections col ON col.id = cc.collection_id
			WHERE cc.collection_id = ? AND col.user_id = ?
		)`
		args = append(args, cid, p.UserID)
	}
	// sort=position is only meaningful for a single collection; pick the
	// first one when multiple are selected (defensive — the client only ever
	// sets this when exactly one collection is active).
	if p.Sort == "position" && len(p.CollectionIDs) > 0 {
		firstColl := p.CollectionIDs[0]
		sortExpr = `(SELECT position FROM collection_comics
		             WHERE collection_id = ` + strconv.FormatInt(firstColl, 10) +
			` AND comic_id = c.id)`
		order = "ASC"
	}

	base := `FROM comics c LEFT JOIN reading_progress rp ON rp.comic_id = c.id AND rp.user_id = ? ` + where

	var total int
	if err := d.db.QueryRow(`SELECT COUNT(*) `+base, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (p.Page - 1) * p.PerPage
	rows, err := d.db.Query(
		fmt.Sprintf(`SELECT c.id, c.path, c.title, c.series, c.volume, c.issue,
			c.format, c.page_count, c.cover_path, c.custom_cover, c.file_size, c.date_added, c.file_mtime,
			rp.last_page, rp.last_cfi, rp.updated_at
			%s ORDER BY %s %s LIMIT ? OFFSET ?`, base, sortExpr, order),
		append(args, p.PerPage, offset)...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []*ComicWithProgress
	for rows.Next() {
		c := &ComicWithProgress{}
		if err := rows.Scan(
			&c.ID, &c.Path, &c.Title, &c.Series, &c.Volume, &c.Issue,
			&c.Format, &c.PageCount, &c.CoverPath, &c.CustomCover, &c.FileSize, &c.DateAdded, &c.FileMtime,
			&c.LastPage, &c.LastCFI, &c.ProgressUpdatedAt,
		); err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

func (d *DB) AllComicPaths() ([]string, error) {
	rows, err := d.db.Query(`SELECT path FROM comics`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		paths = append(paths, p)
	}
	return paths, rows.Err()
}

func (d *DB) DeleteComicByPath(path string) error {
	_, err := d.db.Exec(`DELETE FROM comics WHERE path = ?`, path)
	return err
}

// --- progress ---

// UpsertProgress writes a reading position, but only if the supplied seq is
// strictly greater than the seq already stored. This is the last-write-wins
// guard for concurrent saves: rapid forward-then-backward paging fires
// several saves whose HTTP responses can land in arbitrary order, and an
// older value with a smaller seq must not be allowed to clobber a newer one.
//
// Pass seq=0 to disable the guard (used by the legacy sendBeacon path).
func (d *DB) UpsertProgress(userID, comicID int64, lastPage int, lastCFI string, seq int64) error {
	_, err := d.db.Exec(`
		INSERT INTO reading_progress (user_id, comic_id, last_page, last_cfi, seq, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, comic_id) DO UPDATE SET
			last_page  = excluded.last_page,
			last_cfi   = excluded.last_cfi,
			seq        = excluded.seq,
			updated_at = excluded.updated_at
		WHERE excluded.seq = 0 OR excluded.seq > reading_progress.seq`,
		userID, comicID, lastPage, lastCFI, seq,
	)
	return err
}

func (d *DB) GetProgress(userID, comicID int64) (*Progress, error) {
	p := &Progress{}
	err := d.db.QueryRow(
		`SELECT last_page, last_cfi, updated_at FROM reading_progress WHERE user_id = ? AND comic_id = ?`,
		userID, comicID,
	).Scan(&p.LastPage, &p.LastCFI, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return p, err
}

// --- custom covers ---

func (d *DB) SetCustomCover(id int64, coverPath string) error {
	_, err := d.db.Exec(
		`UPDATE comics SET cover_path = ?, custom_cover = 1 WHERE id = ?`,
		coverPath, id,
	)
	return err
}

func (d *DB) ClearCustomCover(id int64) error {
	_, err := d.db.Exec(
		`UPDATE comics SET cover_path = '', custom_cover = 0 WHERE id = ?`,
		id,
	)
	return err
}

// SetAutoCover marks a comic as having an auto-generated cover at coverPath.
// Used after server-side regeneration replaces a custom thumbnail.
func (d *DB) SetAutoCover(id int64, coverPath string) error {
	_, err := d.db.Exec(
		`UPDATE comics SET cover_path = ?, custom_cover = 0 WHERE id = ?`,
		coverPath, id,
	)
	return err
}

// --- labels ---

func (d *DB) ListLabels(userID int64) ([]*Label, error) {
	rows, err := d.db.Query(
		`SELECT id, name, color FROM labels WHERE user_id = ? ORDER BY name COLLATE NOCASE`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Label
	for rows.Next() {
		l := &Label{}
		if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (d *DB) CreateLabel(userID int64, name, color string) (*Label, error) {
	res, err := d.db.Exec(
		`INSERT INTO labels (user_id, name, color) VALUES (?, ?, ?)`,
		userID, name, color,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Label{ID: id, Name: name, Color: color}, nil
}

func (d *DB) UpdateLabel(id, userID int64, name, color string) error {
	_, err := d.db.Exec(
		`UPDATE labels SET name = ?, color = ? WHERE id = ? AND user_id = ?`,
		name, color, id, userID,
	)
	return err
}

func (d *DB) DeleteLabel(id, userID int64) error {
	_, err := d.db.Exec(`DELETE FROM labels WHERE id = ? AND user_id = ?`, id, userID)
	return err
}

func (d *DB) AssignLabel(comicID, labelID, userID int64) error {
	// Verify ownership via subquery so a user can't attach another user's label
	_, err := d.db.Exec(
		`INSERT OR IGNORE INTO comic_labels (comic_id, label_id)
		 SELECT ?, id FROM labels WHERE id = ? AND user_id = ?`,
		comicID, labelID, userID,
	)
	return err
}

func (d *DB) UnassignLabel(comicID, labelID, userID int64) error {
	_, err := d.db.Exec(
		`DELETE FROM comic_labels
		 WHERE comic_id = ? AND label_id IN (SELECT id FROM labels WHERE id = ? AND user_id = ?)`,
		comicID, labelID, userID,
	)
	return err
}

func (d *DB) ComicLabels(comicID, userID int64) ([]*Label, error) {
	rows, err := d.db.Query(
		`SELECT l.id, l.name, l.color
		   FROM labels l
		   JOIN comic_labels cl ON cl.label_id = l.id
		  WHERE cl.comic_id = ? AND l.user_id = ?
		  ORDER BY l.name COLLATE NOCASE`,
		comicID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Label
	for rows.Next() {
		l := &Label{}
		if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// LabelsForComics returns labels grouped by comic_id for the given comic IDs,
// scoped to a single user. Used to attach labels to ListComics results in one query.
func (d *DB) LabelsForComics(userID int64, comicIDs []int64) (map[int64][]*Label, error) {
	out := make(map[int64][]*Label)
	if len(comicIDs) == 0 {
		return out, nil
	}
	placeholders := make([]string, len(comicIDs))
	args := make([]any, 0, len(comicIDs)+1)
	args = append(args, userID)
	for i, id := range comicIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := `SELECT cl.comic_id, l.id, l.name, l.color
	           FROM labels l
	           JOIN comic_labels cl ON cl.label_id = l.id
	          WHERE l.user_id = ? AND cl.comic_id IN (` + strings.Join(placeholders, ",") + `)
	          ORDER BY l.name COLLATE NOCASE`
	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int64
		l := &Label{}
		if err := rows.Scan(&cid, &l.ID, &l.Name, &l.Color); err != nil {
			return nil, err
		}
		out[cid] = append(out[cid], l)
	}
	return out, rows.Err()
}

// --- collections ---

func (d *DB) ListCollections(userID int64) ([]*Collection, error) {
	rows, err := d.db.Query(`
		SELECT c.id, c.name, c.created_at,
		       (SELECT COUNT(*) FROM collection_comics WHERE collection_id = c.id) AS comic_count,
		       (SELECT COUNT(*) FROM collection_comics cc
		           JOIN comics cm ON cm.id = cc.comic_id
		           LEFT JOIN reading_progress rp
		             ON rp.comic_id = cm.id AND rp.user_id = c.user_id
		         WHERE cc.collection_id = c.id
		           AND (rp.last_page IS NULL OR cm.page_count = 0 OR rp.last_page < cm.page_count)
		       ) AS unread_count,
		       COALESCE((
		         SELECT GROUP_CONCAT(comic_id) FROM (
		           SELECT comic_id FROM collection_comics
		            WHERE collection_id = c.id
		            ORDER BY position ASC
		            LIMIT 4
		         )
		       ), '') AS preview_csv
		  FROM collections c
		 WHERE c.user_id = ?
		 ORDER BY c.name COLLATE NOCASE`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Collection
	for rows.Next() {
		c := &Collection{}
		var previewCSV string
		if err := rows.Scan(&c.ID, &c.Name, &c.CreatedAt, &c.ComicCount, &c.UnreadCount, &previewCSV); err != nil {
			return nil, err
		}
		if previewCSV != "" {
			for _, s := range strings.Split(previewCSV, ",") {
				if id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
					c.PreviewIDs = append(c.PreviewIDs, id)
				}
			}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) CreateCollection(userID int64, name string) (*Collection, error) {
	res, err := d.db.Exec(
		`INSERT INTO collections (user_id, name) VALUES (?, ?)`,
		userID, name,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Collection{ID: id, Name: name, CreatedAt: time.Now()}, nil
}

func (d *DB) UpdateCollection(id, userID int64, name string) error {
	_, err := d.db.Exec(
		`UPDATE collections SET name = ? WHERE id = ? AND user_id = ?`,
		name, id, userID,
	)
	return err
}

func (d *DB) DeleteCollection(id, userID int64) error {
	_, err := d.db.Exec(`DELETE FROM collections WHERE id = ? AND user_id = ?`, id, userID)
	return err
}

// AddToCollection appends a comic at the end of the user's collection.
// No-op if the comic is already in the collection or the collection isn't theirs.
func (d *DB) AddToCollection(collectionID, comicID, userID int64) error {
	var nextPos int
	err := d.db.QueryRow(
		`SELECT COALESCE(MAX(position), -1) + 1 FROM collection_comics WHERE collection_id = ?`,
		collectionID,
	).Scan(&nextPos)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(
		`INSERT OR IGNORE INTO collection_comics (collection_id, comic_id, position)
		 SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM collections WHERE id = ? AND user_id = ?)`,
		collectionID, comicID, nextPos, collectionID, userID,
	)
	return err
}

func (d *DB) RemoveFromCollection(collectionID, comicID, userID int64) error {
	_, err := d.db.Exec(
		`DELETE FROM collection_comics
		 WHERE collection_id = ? AND comic_id = ?
		   AND collection_id IN (SELECT id FROM collections WHERE id = ? AND user_id = ?)`,
		collectionID, comicID, collectionID, userID,
	)
	return err
}

// ReorderCollection rewrites positions in the order of the provided comic IDs.
// Comics not in the list are left untouched (this is rarely what you want — pass
// the full list of comics in the collection).
func (d *DB) ReorderCollection(collectionID, userID int64, comicIDs []int64) error {
	// Verify ownership first
	var ok int
	if err := d.db.QueryRow(
		`SELECT 1 FROM collections WHERE id = ? AND user_id = ?`,
		collectionID, userID,
	).Scan(&ok); err != nil {
		return err
	}
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`UPDATE collection_comics SET position = ? WHERE collection_id = ? AND comic_id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for i, cid := range comicIDs {
		if _, err := stmt.Exec(i, collectionID, cid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CollectionsForComics returns collection membership grouped by comic_id, scoped to a user.
// Used to render "in collection X, Y" info on comic responses without N+1 queries.
func (d *DB) CollectionsForComics(userID int64, comicIDs []int64) (map[int64][]*Collection, error) {
	out := make(map[int64][]*Collection)
	if len(comicIDs) == 0 {
		return out, nil
	}
	placeholders := make([]string, len(comicIDs))
	args := make([]any, 0, len(comicIDs)+1)
	args = append(args, userID)
	for i, id := range comicIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := `SELECT cc.comic_id, c.id, c.name
	           FROM collections c
	           JOIN collection_comics cc ON cc.collection_id = c.id
	          WHERE c.user_id = ? AND cc.comic_id IN (` + strings.Join(placeholders, ",") + `)
	          ORDER BY c.name COLLATE NOCASE`
	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int64
		c := &Collection{}
		if err := rows.Scan(&cid, &c.ID, &c.Name); err != nil {
			return nil, err
		}
		out[cid] = append(out[cid], c)
	}
	return out, rows.Err()
}

// --- library paths ---

func (d *DB) ListLibraryPaths() ([]*LibraryPath, error) {
	rows, err := d.db.Query(`SELECT id, path, added_at FROM library_paths ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*LibraryPath
	for rows.Next() {
		p := &LibraryPath{}
		if err := rows.Scan(&p.ID, &p.Path, &p.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AllLibraryPaths returns just the path strings for the scanner.
func (d *DB) AllLibraryPaths() ([]string, error) {
	rows, err := d.db.Query(`SELECT path FROM library_paths`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) AddLibraryPath(path string) (*LibraryPath, error) {
	res, err := d.db.Exec(`INSERT INTO library_paths (path) VALUES (?)`, path)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &LibraryPath{ID: id, Path: path, AddedAt: time.Now()}, nil
}

// RemoveLibraryPath deletes a library path. Comics whose path starts with this
// directory are also deleted (cascading their progress, labels, collections).
func (d *DB) RemoveLibraryPath(id int64) error {
	var path string
	if err := d.db.QueryRow(`SELECT path FROM library_paths WHERE id = ?`, id).Scan(&path); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	if _, err := d.db.Exec(`DELETE FROM library_paths WHERE id = ?`, id); err != nil {
		return err
	}
	// Best-effort: remove comics that lived under this path. Trailing separator
	// avoids matching unrelated paths that happen to share a prefix.
	prefix := strings.TrimRight(path, string(filepath.Separator)) + string(filepath.Separator)
	_, err := d.db.Exec(`DELETE FROM comics WHERE path LIKE ?`, prefix+"%")
	return err
}

// --- ignored paths ---

func (d *DB) ListIgnoredPaths() ([]*IgnoredPath, error) {
	rows, err := d.db.Query(`SELECT path, added_at FROM ignored_paths ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*IgnoredPath
	for rows.Next() {
		p := &IgnoredPath{}
		if err := rows.Scan(&p.Path, &p.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) IgnoredPathSet() (map[string]bool, error) {
	rows, err := d.db.Query(`SELECT path FROM ignored_paths`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool)
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out[p] = true
	}
	return out, rows.Err()
}

func (d *DB) AddIgnoredPath(path string) error {
	_, err := d.db.Exec(`INSERT OR IGNORE INTO ignored_paths (path) VALUES (?)`, path)
	return err
}

func (d *DB) RemoveIgnoredPath(path string) error {
	_, err := d.db.Exec(`DELETE FROM ignored_paths WHERE path = ?`, path)
	return err
}
