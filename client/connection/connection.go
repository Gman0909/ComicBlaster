// Package connection owns the "which server am I talking to right now"
// state — the URL of the chosen ComicBlaster server plus the JWT that
// authenticates us against it.
//
// The two pieces are stored separately on purpose:
//
//   - URL lives in plaintext under the user's standard config dir
//     (os.UserConfigDir/ComicBlaster/connection.json). That's a regular
//     file the user can inspect / hand-edit in a pinch. There's nothing
//     secret about "I connect to pi.local:8082".
//
//   - JWT lives in the OS keyring (Windows Credential Manager / macOS
//     Keychain / Linux Secret Service). That's where credentials
//     belong; OS-level access controls protect it from other apps + a
//     compromised webview can't enumerate it via the keyring API
//     because the call goes through the Wails Go side, not JS.
//
// The package is intentionally a thin wrapper over the storage
// backends. Higher-level logic (auto-reconnect, health checks,
// restart-and-wait) is in app.go where it can wire RPC bindings the
// frontend will call.
package connection

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

const (
	// keyringService groups all our credential entries under one name
	// when the user browses Credential Manager / Keychain Access. The
	// account portion picks out a specific server — we support exactly
	// one for now ("default") but the schema leaves room for multi-
	// server profiles later.
	keyringService = "ComicBlaster"
	keyringAccount = "default"
)

// State is the JSON shape that round-trips through the config file +
// over the Wails RPC boundary to the frontend.
type State struct {
	URL     string `json:"url"`               // http(s)://host:port (no /api)
	Name    string `json:"name,omitempty"`    // friendly name from /api/discover
	Token   string `json:"token,omitempty"`   // JWT — omitted when reading from config file alone
	Version string `json:"version,omitempty"` // server version at last connect
}

// Manager reads / writes the saved connection.
type Manager struct {
	configPath string
}

// New returns a Manager that persists under the OS's standard user
// config dir. mkdir-all is done lazily on first write so a fresh
// install doesn't touch the disk until the user actually connects.
func New() *Manager {
	base, err := os.UserConfigDir()
	if err != nil {
		// Fallback: stash next to the binary. Acceptable on systems
		// where UserConfigDir somehow fails (rare).
		exe, _ := os.Executable()
		base = filepath.Dir(exe)
	}
	return &Manager{
		configPath: filepath.Join(base, "ComicBlaster", "connection.json"),
	}
}

// Load returns the saved state — URL + name + version from disk, token
// from the keyring. Returns (nil, nil) when nothing has been saved yet
// so the frontend can show the discovery picker on first launch.
func (m *Manager) Load() (*State, error) {
	data, err := os.ReadFile(m.configPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read connection file: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse connection file: %w", err)
	}
	if s.URL == "" {
		// File present but no URL — treat as not-saved.
		return nil, nil
	}
	// Token comes from the keyring. A missing entry is fine — it just
	// means the user is logged out (they'll need to log in again, the
	// frontend handles that path).
	token, err := keyring.Get(keyringService, keyringAccount)
	if err == nil {
		s.Token = token
	} else if !errors.Is(err, keyring.ErrNotFound) {
		return nil, fmt.Errorf("read keyring: %w", err)
	}
	return &s, nil
}

// Save persists the URL + name + version to the config file and the
// token to the keyring. Either piece may be empty — saving with an
// empty token simply clears the keyring entry, which is what the
// frontend wants after a logout.
func (m *Manager) Save(s State) error {
	if s.URL == "" {
		return errors.New("connection.Save: URL is required")
	}
	if err := os.MkdirAll(filepath.Dir(m.configPath), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	// Write everything EXCEPT the token to the JSON file. The token
	// only lives in the keyring; storing it in two places makes the
	// security model hand-wavy.
	persisted := State{URL: s.URL, Name: s.Name, Version: s.Version}
	data, err := json.MarshalIndent(persisted, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(m.configPath, data, 0o600); err != nil {
		return fmt.Errorf("write connection file: %w", err)
	}
	if s.Token == "" {
		// Best-effort delete; missing entry is fine.
		_ = keyring.Delete(keyringService, keyringAccount)
		return nil
	}
	if err := keyring.Set(keyringService, keyringAccount, s.Token); err != nil {
		return fmt.Errorf("write keyring: %w", err)
	}
	return nil
}

// Clear removes both halves of the saved state. Used when the user
// hits Disconnect or after a failed reconnect that we don't want to
// keep retrying.
func (m *Manager) Clear() error {
	_ = keyring.Delete(keyringService, keyringAccount) // ignore not-found
	if err := os.Remove(m.configPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove connection file: %w", err)
	}
	return nil
}

// SetToken updates only the keyring half of the state. Called by
// app.go after a successful login when we don't want to rewrite the
// URL/name (they already match the connected server).
func (m *Manager) SetToken(token string) error {
	if token == "" {
		_ = keyring.Delete(keyringService, keyringAccount)
		return nil
	}
	return keyring.Set(keyringService, keyringAccount, token)
}
