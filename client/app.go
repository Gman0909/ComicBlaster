// app.go owns the Wails App struct — anything bound here becomes a
// callable function in the React bundle via Wails' generated JS
// bindings. Keep the surface narrow and JSON-friendly: every parameter
// and return value crosses the JS↔Go boundary, so unexported types
// don't make it across.

package main

import (
	"context"
	"log"
	"time"

	"comicblaster-client/discovery"
)

// App is the Wails lifecycle handle + RPC surface. Its methods are
// auto-exported to the React bundle as e.g.:
//
//	import { Ping } from '../bindings/main/App'
//	const reply = await Ping()
type App struct {
	ctx     context.Context
	version string
}

func NewApp(version string) *App {
	return &App{version: version}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Printf("ComicBlaster client %s — startup", a.version)
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
