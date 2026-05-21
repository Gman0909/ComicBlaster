// Package discovery publishes the server on the local network so native
// clients can find it without the user typing in an IP. Currently
// implements mDNS / Bonjour via zeroconf — _comicblaster._tcp.local
// with the server name + version in TXT records.
package discovery

import (
	"log"
	"os"

	"github.com/grandcat/zeroconf"
)

// Advertiser owns a running mDNS publication. Stop releases the network
// resources; safe to call more than once.
type Advertiser struct {
	server *zeroconf.Server
}

// Start publishes the server on the LAN. Returns a no-op Advertiser if
// enabled is false so callers can use the same defer-stop dance whether
// advertising is on or off. Errors from the underlying zeroconf register
// are logged and swallowed — failure to advertise must NOT prevent the
// HTTP server from starting (it's an enhancement, not a requirement).
//
// `name` shows up to humans browsing the network (Bonjour, dns-sd, the
// native client's discovery picker). `port` is the HTTP port. `version`
// goes into a TXT record so clients can decide whether to try connecting.
func Start(enabled bool, name string, port int, version string) *Advertiser {
	a := &Advertiser{}
	if !enabled {
		return a
	}
	if name == "" {
		if h, err := os.Hostname(); err == nil {
			name = h
		} else {
			name = "ComicBlaster"
		}
	}
	srv, err := zeroconf.Register(
		name,                  // friendly instance name
		"_comicblaster._tcp",  // service type
		"local.",              // domain
		port,
		[]string{"version=" + version, "path=/api"},
		nil, // all interfaces
	)
	if err != nil {
		log.Printf("mdns: advertise failed (continuing without discovery): %v", err)
		return a
	}
	a.server = srv
	log.Printf("mdns: advertising _comicblaster._tcp as %q on port %d", name, port)
	return a
}

// Stop tears down the published service. Idempotent.
func (a *Advertiser) Stop() {
	if a == nil || a.server == nil {
		return
	}
	a.server.Shutdown()
	a.server = nil
}
