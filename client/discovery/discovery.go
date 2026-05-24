// Package discovery finds ComicBlaster servers on the network.
//
// Three layers, each tried in parallel:
//
//  1. mDNS / Bonjour — browses for _comicblaster._tcp.local services
//     that the server publishes via internal/discovery/mdns.go. Covers
//     ordinary LANs where multicast is allowed.
//  2. Tailscale CLI — runs `tailscale status --json` if the binary is
//     on PATH and probes each peer's IP. Covers tailnets where mDNS
//     doesn't traverse.
//  3. Manual Probe(URL) — explicitly invoked by the user when neither
//     auto-discovery layer turned anything up. Hits /api/discover to
//     verify the URL actually points at a ComicBlaster server.
//
// All probes have an aggressive per-call timeout so a slow tailnet
// peer can't hold up the picker.
package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// ServerInfo is what the frontend gets back from any discovery layer.
// All fields are JSON-friendly so Wails can ferry them across the
// Go↔JS boundary without custom marshalling.
type ServerInfo struct {
	Name      string `json:"name"`
	URL       string `json:"url"`              // http(s)://host:port (no trailing /api)
	Version   string `json:"version"`
	Source    string `json:"source"`           // "mdns" | "tailscale" | "manual"
	LatencyMS int    `json:"latency_ms"`
}

// probeTimeout is how long a single GET /api/discover is allowed to
// take. Generous enough for a Tailscale peer over a poor connection,
// tight enough that a dead host doesn't stall the whole picker.
const probeTimeout = 1500 * time.Millisecond

// Browse runs every discovery layer in parallel up to the supplied
// timeout, deduplicates results by URL, and returns whatever it found.
// Returns an empty slice (not nil) so the JS side gets a JSON array
// rather than a null literal.
func Browse(ctx context.Context, timeout time.Duration) []ServerInfo {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	results := make(chan ServerInfo, 32)
	var wg sync.WaitGroup

	wg.Add(2)
	go func() { defer wg.Done(); browseMDNS(ctx, results) }()
	go func() { defer wg.Done(); browseTailscale(ctx, results) }()

	// Closer goroutine — once both layers are done emitting we close
	// the channel so the collector loop below exits cleanly.
	go func() { wg.Wait(); close(results) }()

	seen := make(map[string]ServerInfo)
	for s := range results {
		if existing, ok := seen[s.URL]; !ok || s.LatencyMS < existing.LatencyMS {
			seen[s.URL] = s
		}
	}
	out := make([]ServerInfo, 0, len(seen))
	for _, s := range seen {
		out = append(out, s)
	}
	return out
}

// Probe verifies a candidate URL points at a ComicBlaster server by
// hitting /api/discover. Used directly by the manual-entry UI and by
// each auto-discovery layer to confirm a candidate before reporting.
func Probe(ctx context.Context, base string) (*ServerInfo, error) {
	base = strings.TrimRight(base, "/")
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "http://" + base
	}
	t0 := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/discover", nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: probeTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discover returned %d", res.StatusCode)
	}
	var body struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("discover body: %w", err)
	}
	return &ServerInfo{
		Name:      body.Name,
		URL:       base,
		Version:   body.Version,
		LatencyMS: int(time.Since(t0).Milliseconds()),
	}, nil
}

// browseMDNS walks the network for _comicblaster._tcp.local records.
// Each match is probed via Probe() to confirm it's actually a
// ComicBlaster server and to capture the version + latency.
//
// Probe goroutines are tracked in a local WaitGroup so this function
// only returns after they've all finished. That keeps Browse's
// outer wg.Wait → close(results) sequence safe — without it, a slow
// probe could race past the channel close and panic.
func browseMDNS(ctx context.Context, out chan<- ServerInfo) {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return
	}
	entries := make(chan *zeroconf.ServiceEntry, 16)
	go func() {
		// Browse blocks until ctx is done — give it the same deadline
		// as the parent so we don't outlive our budget.
		_ = resolver.Browse(ctx, "_comicblaster._tcp", "local.", entries)
	}()
	var probes sync.WaitGroup
	defer probes.Wait()
	for entry := range entries {
		host := pickHost(entry)
		if host == "" {
			continue
		}
		url := fmt.Sprintf("http://%s:%d", host, entry.Port)
		probes.Add(1)
		go func(u string) {
			defer probes.Done()
			pctx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			info, err := Probe(pctx, u)
			if err != nil {
				return
			}
			info.Source = "mdns"
			select {
			case out <- *info:
			case <-ctx.Done():
			}
		}(url)
	}
}

// pickHost prefers an IPv4 address from the mDNS A record; falls back
// to the resolved hostname so .local lookups still work on systems
// without a multicast DNS resolver. IPv6 is intentionally skipped —
// link-local addresses can be flaky cross-router.
func pickHost(entry *zeroconf.ServiceEntry) string {
	if len(entry.AddrIPv4) > 0 {
		return entry.AddrIPv4[0].String()
	}
	if entry.HostName != "" {
		return strings.TrimSuffix(entry.HostName, ".")
	}
	return ""
}

// browseTailscale uses the tailscale CLI to enumerate peers and probe
// each one. Best-effort: if the binary isn't on PATH (likely on
// non-Tailscale machines) we silently return so the other layers can
// still produce results.
//
// Two URL variants are probed per peer:
//
//   - https://<MagicDNS-name>:<port>  — covers peers that run
//     `tailscale serve` (TLS-terminated). This is the URL the user
//     should pick if they want the connection to keep working when
//     they leave the LAN, because MagicDNS resolves from anywhere on
//     the tailnet, and the cert is Let's Encrypt-signed.
//   - http://<TailscaleIP>:<port>     — covers plain HTTP on the
//     tailnet (no Serve / Funnel in front). Fallback for setups that
//     don't terminate TLS.
//
// Both are emitted on success so the picker can show whichever the
// peer actually responds to. They have distinct URLs so the dedupe in
// Browse() leaves both visible.
func browseTailscale(ctx context.Context, out chan<- ServerInfo) {
	cmd := exec.CommandContext(ctx, "tailscale", "status", "--json")
	output, err := cmd.Output()
	if err != nil {
		return // tailscale not installed / not running / not logged in
	}
	var status struct {
		Peer map[string]struct {
			HostName     string   `json:"HostName"`
			DNSName      string   `json:"DNSName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
			Online       bool     `json:"Online"`
		} `json:"Peer"`
	}
	if err := json.Unmarshal(output, &status); err != nil {
		return
	}
	// Default port — same as the server's default. If users have
	// remapped the HTTP port the manual-entry path covers it.
	const defaultPort = 8082
	var probes sync.WaitGroup
	defer probes.Wait()
	probe := func(u, host string) {
		defer probes.Done()
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		info, err := Probe(pctx, u)
		if err != nil {
			return
		}
		info.Source = "tailscale"
		// Tailscale's hostname is more useful than the /api/discover
		// name when both are present — matches what `tailscale
		// status` shows in the picker.
		if host != "" {
			info.Name = host
		}
		select {
		case out <- *info:
		case <-ctx.Done():
		}
	}
	for _, p := range status.Peer {
		if !p.Online || len(p.TailscaleIPs) == 0 {
			continue
		}
		if dns := strings.TrimSuffix(p.DNSName, "."); dns != "" {
			probes.Add(1)
			go probe(fmt.Sprintf("https://%s:%d", dns, defaultPort), p.HostName)
		}
		ip := p.TailscaleIPs[0]
		probes.Add(1)
		go probe(fmt.Sprintf("http://%s:%d", ip, defaultPort), p.HostName)
	}
}
