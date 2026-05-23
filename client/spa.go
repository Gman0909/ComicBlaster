package main

import (
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	"comicblaster-client/offline"
)

// offlinePathPrefix is the special URL path the React side fetches
// when a comic is available locally. The Wails AssetServer
// intercepts these BEFORE falling through to the embedded SPA so
// the same code path can serve "I want the React bundle" requests
// and "I want a locally-stored comic" requests.
//
// Using a same-origin path (rather than a custom scheme like
// cb://offline/) keeps everything inside the existing fetch / XHR
// auth + caching layer, and avoids the cross-origin quirks that
// epub.js + pdf.js have when their iframes pull from a non-http
// scheme.
const offlinePathPrefix = "/_offline/"

// spaHandler serves files from the embedded React bundle, falling back to
// index.html for any path that doesn't map to a real asset. Without this,
// reloading on /read/123 or navigating to /settings via a deep link would
// return 404; with it, the same SPA fallback that the Go server applies
// for the browser deployment is preserved inside Wails.
//
// Special case: paths under /_offline/ are served from the offline
// manifest's local file store. This is how Reader.tsx / ReaderEpub.tsx
// can swap their file source URL when a comic is downloaded without
// having to learn about Wails plumbing — they just fetch a different
// URL.
func spaHandler(root fs.FS, off *offline.Manager) http.Handler {
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Offline file routes:
		//   /_offline/<id>             → whole archive (PDF/ePub) via http.ServeFile
		//   /_offline/<id>/pages/<n>   → Nth image inside a local CBZ/CBR via ServePage
		// The /pages/N path is what Reader.tsx hits when a downloaded comic
		// is being read offline; the bare path is what pdf.js / epub.js
		// stream from for whole-file formats.
		if strings.HasPrefix(r.URL.Path, offlinePathPrefix) {
			rest := strings.TrimPrefix(r.URL.Path, offlinePathPrefix)
			// Split into "<id>" or "<id>/pages/<n>"
			parts := strings.Split(rest, "/")
			if len(parts) == 0 || parts[0] == "" {
				http.Error(w, "bad offline path", http.StatusBadRequest)
				return
			}
			id, err := strconv.ParseInt(parts[0], 10, 64)
			if err != nil {
				http.Error(w, "bad comic id", http.StatusBadRequest)
				return
			}
			if len(parts) == 1 {
				fp := off.FilePath(id)
				if fp == "" {
					http.Error(w, "not downloaded", http.StatusNotFound)
					return
				}
				// http.ServeFile sets Content-Type + Last-Modified +
				// supports Range requests, which pdf.js relies on for
				// progressive loading of large PDFs.
				http.ServeFile(w, r, fp)
				return
			}
			if len(parts) == 3 && parts[1] == "pages" {
				n, err := strconv.Atoi(parts[2])
				if err != nil {
					http.Error(w, "bad page number", http.StatusBadRequest)
					return
				}
				// Server's /api/comics/{id}/pages/{n} treats n as
				// 1-indexed (Page(n-1) on the reader). React calls
				// both endpoints with the same n, so the offline
				// passthrough has to use the same convention or the
				// native client would skip the cover (page 1 → array
				// index 1 = second image). Subtract 1 here to match.
				off.ServePage(w, r, id, n-1)
				return
			}
			http.Error(w, "bad offline path", http.StatusBadRequest)
			return
		}

		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" {
			fileServer.ServeHTTP(w, r)
			return
		}
		if _, err := fs.Stat(root, clean); err != nil {
			// File doesn't exist — serve index.html so React Router can
			// resolve the path on the client side.
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
