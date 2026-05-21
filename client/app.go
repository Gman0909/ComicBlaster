// app.go owns the Wails App struct — anything bound here becomes a
// callable function in the React bundle via Wails' generated JS
// bindings. Keep the surface narrow and JSON-friendly: every parameter
// and return value crosses the JS↔Go boundary, so unexported types
// don't make it across.

package main

import (
	"context"
	"log"
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
