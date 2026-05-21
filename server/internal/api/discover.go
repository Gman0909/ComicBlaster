package api

import (
	"log"
	"net/http"
	"os"
	"time"
)

// handleDiscover answers the public "is this a ComicBlaster server?" probe.
// Native clients use it to verify a candidate host:port from mDNS / UDP /
// Tailscale / manual entry actually speaks our protocol before they show
// the user a connect button.
//
// Response shape is deliberately small; clients should not depend on
// fields beyond what's documented here:
//
//	{
//	  "name":          "<friendly server name>",
//	  "version":       "<binary version>",
//	  "requires_auth": true,
//	  "api":           "/api"
//	}
func (s *server) handleDiscover(w http.ResponseWriter, _ *http.Request) {
	name := s.cfg.Server.AdvertiseName
	if name == "" {
		if h, err := os.Hostname(); err == nil {
			name = h
		} else {
			name = "ComicBlaster"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          name,
		"version":       version,
		"requires_auth": true,
		"api":           "/api",
	})
}

// handleAdminRestart asks the OS service manager to bring us back. Pre-
// requisite: the process is being supervised by systemd / Windows
// Scheduled Task / similar (every install method we ship does this).
//
// We deliberately use os.Exit(1) and a short delay rather than a clean
// HTTP shutdown:
//
//   - The Pi's systemd unit ships with Restart=on-failure, so exit(0)
//     would NOT trigger a restart. exit(1) reliably does.
//   - We respond with 202 + delay so the client gets a confirmation
//     before the socket dies; otherwise it sees ERR_CONNECTION_RESET
//     and can't tell whether the call succeeded.
func (s *server) handleAdminRestart(w http.ResponseWriter, _ *http.Request) {
	log.Printf("admin restart requested; exiting in 250ms so the supervisor brings us back")
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status": "restarting",
	})
	go func() {
		time.Sleep(250 * time.Millisecond)
		os.Exit(1)
	}()
}
