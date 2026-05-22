package api

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"comicblaster/internal/auth"
	"comicblaster/internal/config"
	"comicblaster/internal/scanner"
	"comicblaster/internal/storage"
)

type server struct {
	cfg     *config.Config
	db      *storage.DB
	scanner *scanner.Scanner
}

// version is set by main via SetVersion at startup. It's deliberately a
// package-level value so the public /api/version handler doesn't have to
// thread it through the request context.
var version = "dev"

// SetVersion injects the binary's release tag for the /api/version handler.
func SetVersion(v string) { version = v }

type contextKey int

const claimsKey contextKey = iota

func NewServer(cfg *config.Config, db *storage.DB, sc *scanner.Scanner) http.Handler {
	s := &server{cfg: cfg, db: db, scanner: sc}
	return s.routes()
}

func (s *server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	r.Route("/api", func(r chi.Router) {
		// Public — setup, login, version
		r.Get("/auth/setup", s.handleSetupStatus)
		r.Post("/auth/setup", s.handleSetup)
		r.Post("/auth/login", s.handleLogin)
		r.Post("/auth/logout", s.handleLogout)
		r.Get("/version", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"version": version})
		})
		// Public discovery probe. Native clients hit this once they have
		// a candidate host:port (from mDNS, UDP broadcast, Tailscale peer
		// list, or manual entry) to confirm "this is actually a
		// ComicBlaster server" and learn its friendly name + version
		// before showing it in the picker. Intentionally unauthenticated
		// — leaking the name + version is the cost of being discoverable.
		r.Get("/discover", s.handleDiscover)

		// Authenticated
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)

			r.Get("/auth/me", s.handleMe)
				r.Post("/auth/password", s.handleChangePassword)

			r.Get("/comics", s.handleListComics)
			r.Get("/comics/{id}", s.handleGetComic)
			r.Get("/comics/{id}/cover", s.handleGetCover)
			r.Post("/comics/{id}/cover", s.handleSetCover)
			r.Post("/comics/{id}/cover/upload", s.handleUploadCover)
			r.Delete("/comics/{id}/cover", s.handleClearCover)
				r.Get("/comics/{id}/file", s.handleGetFile)
			r.Get("/comics/{id}/pages/{n}", s.handleGetPage)
			r.Get("/comics/{id}/progress", s.handleGetProgress)
			r.Post("/comics/{id}/progress", s.handlePostProgress)
			r.Post("/comics/{id}/pagecount", s.handleSetPageCount)

			r.Post("/scan", s.handleTriggerScan)
			r.Get("/scan/status", s.handleScanStatus)

			r.Get("/labels", s.handleListLabels)
			r.Post("/labels", s.handleCreateLabel)
			r.Put("/labels/{id}", s.handleUpdateLabel)
			r.Delete("/labels/{id}", s.handleDeleteLabel)
			r.Post("/comics/{id}/labels/{label_id}", s.handleAssignLabel)
			r.Delete("/comics/{id}/labels/{label_id}", s.handleUnassignLabel)

			r.Get("/collections", s.handleListCollections)
			r.Post("/collections", s.handleCreateCollection)
			r.Put("/collections/{id}", s.handleUpdateCollection)
			r.Delete("/collections/{id}", s.handleDeleteCollection)
			r.Put("/collections/{id}/order", s.handleReorderCollection)
			r.Post("/collections/{id}/comics/{comic_id}", s.handleAddToCollection)
			r.Delete("/collections/{id}/comics/{comic_id}", s.handleRemoveFromCollection)

			// Admin only
			r.Group(func(r chi.Router) {
				r.Use(s.requireAdmin)
				r.Get("/admin/users", s.handleListUsers)
				r.Post("/admin/users", s.handleCreateUser)
				r.Delete("/admin/users/{id}", s.handleDeleteUser)
				r.Post("/admin/users/{id}/reset-password", s.handleResetPassword)

				r.Get("/admin/library/paths", s.handleListLibraryPaths)
				r.Post("/admin/library/paths", s.handleAddLibraryPath)
				r.Delete("/admin/library/paths/{id}", s.handleRemoveLibraryPath)
				r.Get("/admin/library/ignored", s.handleListIgnoredPaths)
				r.Post("/admin/library/unignore", s.handleUnignorePath)
				r.Delete("/admin/comics/{id}", s.handleRemoveComic)
				// Server-side filesystem browser for the Add-path UI.
				// Admins only — same trust model as the existing
				// path text input, just made visible.
				r.Get("/admin/browse", s.handleBrowse)
				r.Post("/admin/browse/mkdir", s.handleMkdir)
				// Trigger a service restart. Native clients with an
				// authenticated admin session expose this in the
				// Connection panel. Relies on the service manager
				// (systemd / Windows Scheduled Task) bringing the
				// process back up.
				r.Post("/admin/restart", s.handleAdminRestart)
			})
		})
	})

	// Static web client (SPA)
	if root := s.cfg.Server.WebRoot; root != "" {
		fs := http.FileServer(http.Dir(root))
		r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
			// If file exists on disk, serve it; otherwise serve index.html (SPA routing)
			path := root + r.URL.Path
			if _, err := os.Stat(path); os.IsNotExist(err) && !strings.HasPrefix(r.URL.Path, "/api/") {
				http.ServeFile(w, r, root+"/index.html")
				return
			}
			fs.ServeHTTP(w, r)
		})
	}

	return r
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireAuth accepts either of two credential carriers:
//
//   - Authorization: Bearer <jwt> — used by native clients (Wails). Their
//     UI is served from a non-HTTP origin (wails://, app://, file://) so
//     browser cookies don't work; storing the JWT in the OS keyring and
//     attaching it to every request as a Bearer header is the
//     idiomatic alternative.
//   - cb_token cookie — used by the browser client (httpOnly, SameSite=Lax).
//
// Bearer wins when both are present so a misconfigured client failing
// over to the browser path is impossible to construct. Either path
// produces the same claims object downstream.
func (s *server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenStr := bearerToken(r)
		if tokenStr == "" {
			if cookie, err := r.Cookie("cb_token"); err == nil {
				tokenStr = cookie.Value
			}
		}
		// Third fallback: ?token= query param. <img>, <canvas>, and pdf.js
		// subresource fetches can't be customised to carry an
		// Authorization header, but they can ride a query string. The
		// native (bearer-mode) client appends ?token=<jwt> to media URLs
		// returned by coverUrl/pageUrl/fileUrl. Only honoured on GET so
		// it can't be used as a CSRF carrier on writes.
		if tokenStr == "" && r.Method == http.MethodGet {
			tokenStr = r.URL.Query().Get("token")
		}
		if tokenStr == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		claims, err := auth.ParseToken(tokenStr)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// bearerToken extracts the JWT from an `Authorization: Bearer <token>`
// header. Returns "" if absent or malformed; the auth middleware then
// falls through to the cookie path.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

func (s *server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if getClaims(r).Role != "admin" {
			writeError(w, http.StatusForbidden, "admin required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func getClaims(r *http.Request) *auth.Claims {
	return r.Context().Value(claimsKey).(*auth.Claims)
}
