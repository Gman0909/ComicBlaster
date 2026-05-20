package main

import (
	"context"
	"flag"
	"fmt"
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
	"comicblaster/internal/scanner"
	"comicblaster/internal/storage"

	_ "comicblaster/internal/reader" // register format readers via init()
)

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

	srv := api.NewServer(cfg, db, sc)
	addr := fmt.Sprintf(":%d", cfg.Server.HTTPPort)
	httpSrv := &http.Server{Addr: addr, Handler: srv}

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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
