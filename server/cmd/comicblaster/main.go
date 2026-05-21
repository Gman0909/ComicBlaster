package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"comicblaster/internal/api"
	"comicblaster/internal/auth"
	"comicblaster/internal/config"
	"comicblaster/internal/discovery"
	"comicblaster/internal/scanner"
	"comicblaster/internal/storage"

	_ "comicblaster/internal/reader" // register format readers via init()
)

// Version is the human-readable release tag baked into the binary. Override
// at build time with: go build -ldflags "-X main.Version=v0.3.0"
var Version = "v0.2.0"

// Page-cache eviction: anything older than this is fair game for cleanup,
// run on startup and on a recurring tick so the directory doesn't grow
// without bound. Source comic mtime changes already shadow stale entries,
// so the TTL only kills truly unused pages.
const (
	pageCacheTTL      = 14 * 24 * time.Hour
	pageCacheInterval = 6 * time.Hour
)

func startPageCacheCleanup(dataDir string) {
	root := filepath.Join(dataDir, "page_cache")
	cleanup := func() {
		cutoff := time.Now().Add(-pageCacheTTL)
		var files, dirs int
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			if info.ModTime().Before(cutoff) {
				if os.Remove(path) == nil {
					files++
				}
			}
			return nil
		})
		// Sweep empty per-comic subdirs.
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			d := filepath.Join(root, e.Name())
			children, _ := os.ReadDir(d)
			if len(children) == 0 {
				if os.Remove(d) == nil {
					dirs++
				}
			}
		}
		if files > 0 || dirs > 0 {
			log.Printf("page_cache: evicted %d files / %d empty dirs (ttl=%s)", files, dirs, pageCacheTTL)
		}
	}

	go func() {
		cleanup()
		t := time.NewTicker(pageCacheInterval)
		defer t.Stop()
		for range t.C {
			cleanup()
		}
	}()
}

func main() {
	configPath := flag.String("config", "", "path to config.yaml (default: ~/comicblaster-data/config.yaml)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	for _, dir := range []string{
		cfg.DataDir,
		filepath.Join(cfg.DataDir, "covers"),
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	secret, err := config.Secret(cfg.DataDir)
	if err != nil {
		log.Fatalf("secret: %v", err)
	}
	auth.Init(secret)

	db, err := storage.Open(filepath.Join(cfg.DataDir, "comicblaster.db"))
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	defer db.Close()

	// One-time backfill: seed library_paths from config.yaml on first start.
	// Existing installs keep working; new installs start with an empty library.
	if existing, _ := db.AllLibraryPaths(); len(existing) == 0 {
		for _, p := range cfg.Library.Paths {
			if _, err := db.AddLibraryPath(p); err != nil {
				log.Printf("backfill library path %s: %v", p, err)
			}
		}
	}

	sc := scanner.New(db, filepath.Join(cfg.DataDir, "covers"))
	go sc.Scan()
	go sc.Watch(cfg.Library.ScanInterval)

	startPageCacheCleanup(cfg.DataDir)

	api.SetVersion(Version)
	srv := api.NewServer(cfg, db, sc)
	addr := fmt.Sprintf(":%d", cfg.Server.HTTPPort)
	httpSrv := &http.Server{Addr: addr, Handler: srv}

	// Publish on the LAN via mDNS so native clients can auto-discover the
	// server. Best-effort — failure to advertise (no multicast support,
	// network restrictions) logs and continues; the HTTP server still
	// starts and remote/manual entry still works.
	mdns := discovery.Start(
		cfg.Server.MDNSEnabled(),
		cfg.Server.AdvertiseName,
		cfg.Server.HTTPPort,
		Version,
	)
	defer mdns.Stop()

	go func() {
		log.Printf("ComicBlaster listening on http://0.0.0.0%s", addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down...")
	mdns.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
