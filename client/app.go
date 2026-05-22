// app.go owns the Wails App struct — anything bound here becomes a
// callable function in the React bundle via Wails' generated JS
// bindings. Keep the surface narrow and JSON-friendly: every parameter
// and return value crosses the JS↔Go boundary, so unexported types
// don't make it across.

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"comicblaster-client/connection"
	"comicblaster-client/discovery"
	"comicblaster-client/offline"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails lifecycle handle + RPC surface. Its methods are
// auto-exported to the React bundle as e.g.:
//
//	import { Ping } from '../bindings/main/App'
//	const reply = await Ping()
type App struct {
	ctx     context.Context
	version string
	conn    *connection.Manager
	off     *offline.Manager
}

func NewApp(version string) *App {
	return &App{
		version: version,
		conn:    connection.New(),
		off:     offline.New(),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Printf("ComicBlaster client %s — startup", a.version)
	if err := a.off.Load(); err != nil {
		log.Printf("offline: load manifest: %v", err)
	}
}

func (a *App) shutdown(_ context.Context) {
	log.Printf("ComicBlaster client — shutdown")
}

// Ping is a sanity-check binding the frontend can call on boot to
// confirm the Go ↔ JS bridge is working before the heavier discovery /
// connection methods are wired up.
func (a *App) Ping() string {
	return "pong from " + a.version
}

// Version returns the build tag baked into the client binary. The
// Settings → Connection panel displays this alongside the server's
// version so users can tell which side is ahead during upgrades.
func (a *App) Version() string {
	return a.version
}

// Discover runs the configured discovery layers (mDNS, Tailscale CLI)
// in parallel up to a fixed budget. Returns every reachable
// ComicBlaster server found, deduped by URL. Always returns a slice —
// the frontend gets [] not null when nothing is found.
//
// The frontend can call this on launch, on the "Switch server" action,
// and on demand from the Connection panel's Refresh button.
func (a *App) Discover() []discovery.ServerInfo {
	return discovery.Browse(a.ctx, 2*time.Second)
}

// ProbeURL verifies a user-typed URL points at a ComicBlaster server.
// Used by the manual-entry form in the discovery picker. The returned
// ServerInfo carries the server's name + version + measured latency
// so the picker can show them before the user commits.
func (a *App) ProbeURL(url string) (*discovery.ServerInfo, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 3*time.Second)
	defer cancel()
	info, err := discovery.Probe(ctx, url)
	if err != nil {
		return nil, err
	}
	info.Source = "manual"
	return info, nil
}

// GetSavedConnection returns the persisted server URL + JWT (if any).
// Called by the frontend exactly once on boot to decide whether to
// auto-connect or show the discovery picker.
func (a *App) GetSavedConnection() (*connection.State, error) {
	return a.conn.Load()
}

// SaveConnection persists the server URL + name + version (and,
// optionally, the JWT) so the next launch can skip the picker. The
// frontend calls this after a successful login.
func (a *App) SaveConnection(state connection.State) error {
	return a.conn.Save(state)
}

// SetToken updates only the JWT half of the saved connection. Hook
// for the api.ts onToken callback — after a login/logout the frontend
// fires this so the keyring stays in sync without having to re-pass
// the URL.
func (a *App) SetToken(token string) error {
	return a.conn.SetToken(token)
}

// ClearConnection wipes both the config file and the keyring entry.
// Called by the Disconnect action in the Settings → Connection panel.
func (a *App) ClearConnection() error {
	return a.conn.Clear()
}

// RestartServer asks the connected server to bounce its own process
// via POST /api/admin/restart. Only succeeds when the saved JWT
// carries an admin claim; the server's middleware enforces that.
//
// Returns nil on the expected 202 Accepted; any other status is an
// error the frontend can surface. The actual restart happens
// asynchronously on the server side after a 250ms grace period; the
// frontend's job from here is to start polling /api/discover until
// the server reappears.
func (a *App) RestartServer() error {
	saved, err := a.conn.Load()
	if err != nil {
		return fmt.Errorf("load saved connection: %w", err)
	}
	if saved == nil || saved.URL == "" {
		return fmt.Errorf("no saved server to restart")
	}
	if saved.Token == "" {
		return fmt.Errorf("not signed in")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 3*time.Second)
	defer cancel()
	base := strings.TrimRight(saved.URL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/admin/restart", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+saved.Token)
	res, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("restart request: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		return fmt.Errorf("restart returned %d", res.StatusCode)
	}
	return nil
}

// --- offline reading ---------------------------------------------------------
//
// Bindings the React side calls to manage downloaded comics. Storage
// + manifest live under os.UserConfigDir()/ComicBlaster/offline/;
// this file is the Wails-RPC surface.

// DownloadComic streams /api/comics/{id}/file to local disk and adds
// the comic to the offline manifest. The download runs in a
// background goroutine and reports progress via the
// "offline:progress" Wails event — the frontend subscribes once on
// mount and updates per-card progress bars from there. Returns
// immediately; the caller polls DownloadStatus or listens to events.
//
// Parameters come from the frontend because they're all known
// client-side already (Comic.format, Comic.title, Comic.cover_url
// from the API response). Avoiding a server-side metadata lookup
// here means the download flow works even when the React side has a
// fresh cache that the Go side hasn't seen.
type DownloadComicParams struct {
	ComicID  int64  `json:"comic_id"`
	Format   string `json:"format"`
	Title    string `json:"title"`
	CoverURL string `json:"cover_url"`
}

func (a *App) DownloadComic(p DownloadComicParams) error {
	saved, err := a.conn.Load()
	if err != nil {
		return fmt.Errorf("load connection: %w", err)
	}
	if saved == nil || saved.URL == "" {
		return fmt.Errorf("not connected to a server")
	}
	if saved.Token == "" {
		return fmt.Errorf("not signed in")
	}
	go func() {
		_, err := a.off.Download(a.ctx, offline.DownloadParams{
			ComicID:   p.ComicID,
			ServerURL: saved.URL,
			Token:     saved.Token,
			Format:    p.Format,
			Title:     p.Title,
			CoverURL:  p.CoverURL,
		}, func(st *offline.Status) {
			// Push every progress tick to the frontend. The status
			// payload is small (~60 bytes) so this is cheap even
			// for 1% updates on a 1 GB download.
			wailsruntime.EventsEmit(a.ctx, "offline:progress", st)
		})
		if err != nil {
			log.Printf("offline: download %d: %v", p.ComicID, err)
		}
	}()
	return nil
}

// DownloadStatus returns the live or last-known state of a comic.
// Returns nil if the comic has never been downloaded and isn't
// currently downloading — callers should treat that as "not
// downloaded".
func (a *App) DownloadStatus(comicID int64) *offline.Status {
	return a.off.Status(comicID)
}

// RemoveDownload deletes the local file + manifest entry. Idempotent.
func (a *App) RemoveDownload(comicID int64) error {
	return a.off.Remove(comicID)
}

// ListDownloads returns every Entry stored for the currently-saved
// server URL. The Settings → Offline section + library badge query
// this on mount and after every download/remove.
func (a *App) ListDownloads() []offline.Entry {
	saved, err := a.conn.Load()
	if err != nil || saved == nil {
		return a.off.List("") // fall back to everything
	}
	return a.off.List(saved.URL)
}

// StorageInfo aggregates total bytes used + free disk space for the
// Settings UI's storage panel.
func (a *App) StorageInfo() (*offline.StorageInfo, error) {
	saved, err := a.conn.Load()
	if err != nil || saved == nil {
		return a.off.StorageInfo("")
	}
	return a.off.StorageInfo(saved.URL)
}

// RemoveAllDownloads wipes every offline file for the current
// server (or all servers when no connection is saved). Settings →
// Offline's "Remove all" button calls this after confirming with
// the user.
func (a *App) RemoveAllDownloads() error {
	saved, _ := a.conn.Load()
	if saved == nil {
		return a.off.RemoveAll("")
	}
	return a.off.RemoveAll(saved.URL)
}

// CacheLibrary persists the most recent library list so the offline-
// mode bootstrap (Phase E) can render something on first launch
// without a network. The frontend serialises whatever it wants;
// from Go's perspective this is opaque bytes.
func (a *App) CacheLibrary(payload string) error {
	saved, _ := a.conn.Load()
	if saved == nil {
		return fmt.Errorf("no saved server to cache library for")
	}
	return a.off.LibraryCacheWrite(saved.URL, []byte(payload))
}

// LoadCachedLibrary returns the last cached library payload, or ""
// if none exists. Frontend deserialises.
func (a *App) LoadCachedLibrary() (string, error) {
	saved, _ := a.conn.Load()
	if saved == nil {
		return "", nil
	}
	data, err := a.off.LibraryCacheRead(saved.URL)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
