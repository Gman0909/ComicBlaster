// Wails entry for the ComicBlaster native client.
//
// The native client shares its UI codebase with the browser deployment —
// React lives under ../web/ and is built into ../web/dist/, then mirrored
// into ./dist/ by scripts/prepare-frontend.ps1 so Go's //go:embed can
// pick it up (embed doesn't allow '..' in the pattern).
//
// Backend (Go) exposes:
//   - discovery: mDNS browse, UDP broadcast, Tailscale peer probe,
//     manual entry
//   - connection: keyring-backed JWT storage, health checks
//   - admin actions: restart server
//
// Bridge to the frontend is via Wails' RPC bindings — methods on the
// App struct are auto-generated as TypeScript imports under ./bindings/.

package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is the human-readable build tag, set at compile time:
//   wails build -ldflags "-X main.Version=client-v0.3.0"
var Version = "dev"

func main() {
	app := NewApp(Version)

	// Strip the embed root prefix so the asset server sees the React
	// app at "/" rather than "/frontend/dist/".
	rooted, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatalf("embed: %v", err)
	}

	err = wails.Run(&options.App{
		Title:     "ComicBlaster",
		Width:     1280,
		Height:    800,
		MinWidth:  640,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: rooted,
			// Handler also serves locally-downloaded comic files
			// under /_offline/{id} for the offline-reading feature.
			Handler: spaHandler(rooted, app.off),
		},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		BackgroundColour: &options.RGBA{R: 19, G: 19, B: 19, A: 255}, // matches --color-surface dark
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			DisableWindowIcon:    false,
		},
	})
	if err != nil {
		log.Fatalf("wails: %v", err)
	}
}
