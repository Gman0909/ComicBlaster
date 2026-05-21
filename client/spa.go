package main

import (
	"io/fs"
	"net/http"
	"strings"
)

// spaHandler serves files from the embedded React bundle, falling back to
// index.html for any path that doesn't map to a real asset. Without this,
// reloading on /read/123 or navigating to /settings via a deep link would
// return 404; with it, the same SPA fallback that the Go server applies
// for the browser deployment is preserved inside Wails.
func spaHandler(root fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
