package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  ServerConfig  `yaml:"server"`
	Library LibraryConfig `yaml:"library"`
	DataDir string        `yaml:"data_dir"`
}

type ServerConfig struct {
	HTTPPort int    `yaml:"http_port"`
	// HTTPHost binds the listener to a specific interface address.
	// Empty (the default) binds 0.0.0.0 — listen on every interface.
	// Set this when something else on the box already holds the same
	// port on another interface (e.g. Tailscale Serve terminating TLS
	// on the Tailscale IP) so the two don't collide.
	HTTPHost string `yaml:"http_host,omitempty"`
	WebRoot  string `yaml:"web_root"`
	// AdvertiseMDNS controls whether the server publishes itself on the
	// local network via mDNS / Bonjour as _comicblaster._tcp. Native
	// clients use this for auto-discovery on LANs. Defaults to true so
	// new installs get discovery without reading docs first; set to
	// false in config.yaml if you don't want the server to be visible
	// to mDNS browsers (privacy-sensitive networks).
	AdvertiseMDNS *bool `yaml:"advertise_mdns,omitempty"`
	// AdvertiseName is the human-readable name the server publishes in
	// the mDNS TXT record + /api/discover endpoint. Defaults to the
	// machine's hostname when empty.
	AdvertiseName string `yaml:"advertise_name,omitempty"`
}

// MDNSEnabled returns the effective advertise_mdns setting. Pointer-bool
// is used so an absent key falls through to the on-by-default behaviour
// without false-being-the-yaml-zero-value tripping us up.
func (s ServerConfig) MDNSEnabled() bool {
	if s.AdvertiseMDNS == nil {
		return true
	}
	return *s.AdvertiseMDNS
}

type LibraryConfig struct {
	Paths        []string `yaml:"paths"`
	ScanInterval int      `yaml:"scan_interval"`
}

func Load(path string) (*Config, error) {
	cfg := defaults()

	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, "comicblaster-data", "config.yaml")
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return nil, fmt.Errorf("create data dir: %w", err)
		}
		if err := writeDefault(path, cfg); err != nil {
			return nil, fmt.Errorf("write default config: %w", err)
		}
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return cfg, nil
}

// Secret loads or generates the persistent JWT signing secret.
func Secret(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "secret.key")
	data, err := os.ReadFile(path)
	if err == nil {
		return string(data), nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(b)
	if err := os.WriteFile(path, []byte(secret), 0600); err != nil {
		return "", err
	}
	return secret, nil
}

func defaults() *Config {
	home, _ := os.UserHomeDir()
	return &Config{
		Server:  ServerConfig{HTTPPort: 8082},
		Library: LibraryConfig{ScanInterval: 300},
		DataDir: filepath.Join(home, "comicblaster-data"),
	}
}

func writeDefault(path string, cfg *Config) error {
	const header = `# ComicBlaster configuration
# Edit this file and restart the service to apply changes.
#
# library.paths: list of directories containing your comics.
# These can be local paths or network-mounted paths (SMB/NFS mounts).
# Library paths are also managed from the Settings page in the web UI.
# Example:
#   paths:
#     - /mnt/nas/Comics
#     - C:\Users\you\Documents\Comics

`
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append([]byte(header), data...), 0644)
}
