# ComicBlaster

A self-hosted comic, manga, and ePub reader. Single Go binary on the back end,
React on the front end. Runs comfortably on a Raspberry Pi 5 or any small
home server. Designed to read your library off a NAS/SMB mount or a local
folder — no uploads required.

<img width="2165" height="1184" alt="image" src="https://github.com/user-attachments/assets/3a079684-d45f-4501-b1dd-e2cf7e52309a" />


## Features

- **Formats**: CBZ / ZIP, CBR (pure-Go RAR decoder), PDF (rendered client-side
  with pdf.js), ePub (rendered client-side with epub.js, with theme + font
  controls and CFI-based progress tracking)
- **Multi-user** with admin / regular roles; per-user reading progress,
  labels, and collections
- **Smart library**: title / series detection, ComicInfo.xml metadata,
  cover extraction, customisable thumbnails (server-extracted for archives,
  canvas-captured for PDFs / ePubs)
- **Library management**: paths and ignore list managed from Settings (no
  need to edit config.yaml), per-comic hide-or-delete confirmation
- **Powerful selection**: cmd/ctrl-click + shift-click ranges on desktop, a
  Select button on touch; bulk apply labels, add to collections, hide; new
  labels and collections can be created and applied from the bulk bar in one
  step
- **Two library views**: classic grid and a Collections view where each
  collection collapses into a single mosaic-cover card
- **Reader UX**: pinch / wheel / double-tap zoom, axis-locked horizontal
  swipes (no vertical drift), horizontal trackpad scroll → page nav, ePub
  reflow with light/sepia/dark themes and 8-step font sizing
- **Mobile-aware**: safe-area padding on bottom bars, touch-targeted icon
  buttons, hover-and-touch parity for card actions
- **Auto-update**: optional systemd timer / Windows scheduled task that
  pulls + rebuilds + restarts daily

## Quick start

### Linux / Raspberry Pi OS

```bash
git clone https://github.com/Gman0909/ComicBlaster.git
cd ComicBlaster
./scripts/install.sh
```

The installer will check for Go / Node / git, build the server and web
client, write a default config to `~/comicblaster-data/config.yaml`, and
optionally register a `comicblaster.service` systemd unit running as your
current user. It will also offer to enable a nightly auto-update timer.

When done, open <http://localhost:8082> and create the first (admin) user.

### Windows

From an unrestricted PowerShell prompt:

```powershell
git clone https://github.com/Gman0909/ComicBlaster.git
cd ComicBlaster
.\scripts\install.ps1
```

Or double-click `scripts\install.bat` — that runs the same script with
the right execution policy.

The installer builds the binary, writes `%USERPROFILE%\comicblaster-data\config.yaml`,
and optionally registers a `ComicBlaster` scheduled task that launches at
logon plus a daily auto-update task.

Requires: [Go](https://go.dev/dl/), [Node.js LTS](https://nodejs.org/),
and [Git](https://git-scm.com/) on PATH.

## Configuration

`~/comicblaster-data/config.yaml` (or `%USERPROFILE%\comicblaster-data\config.yaml`)
holds:

```yaml
server:
  http_port: 8082            # HTTP port to listen on
  web_root: /path/to/web/dist  # location of the built web client
library:
  paths: []                  # managed through Settings → Library paths
  scan_interval: 300         # seconds between automatic library rescans
data_dir: /path/to/data      # absolute path to the data directory
```

Most users won't need to touch this — the installer writes a working file
and the rest is configured through the **Settings** page in the web UI:

- **Library paths** (admin) — folders the scanner reads
- **Ignored items** (admin) — re-add comics you previously hid
- **Labels** — per-user tags shown as colored chips on cards
- **Collections** — per-user ordered groupings (saved reading lists)
- **Users** (admin) — create accounts, reset passwords

## Updating

After the initial install, either:

- run `./scripts/update.sh` (Linux) or `scripts\update.ps1` (Windows) by hand
- or let the auto-update timer / scheduled task do it nightly (enabled
  during install)

Both methods are `git pull` + rebuild + restart. The data directory and DB
are never touched by an update.

## Development

The server is plain Go 1.22 + `modernc.org/sqlite` (pure-Go, no CGo) under
`server/`. The web client is Vite + React 19 + Tailwind 4 under `web/`.

```bash
# server
cd server
go run ./cmd/comicblaster -config /path/to/config.yaml

# web (in another terminal)
cd web
npm install
npm run dev
# Optional: point Vite's dev proxy at a remote server
CB_API_TARGET=http://192.168.1.50:8082 npm run dev
```

The Vite dev server proxies `/api` to the Go server (defaults to
`http://localhost:8082`).

## Data dir layout

Everything stateful lives in the data dir — back this up to preserve your
library state, progress, and accounts:

```
comicblaster-data/
├── comicblaster.db    # SQLite database (users, comics, labels, …)
├── config.yaml        # configuration
├── covers/            # extracted comic covers (300px JPEG)
└── secret.key         # persistent JWT signing key
```

## License

MIT — see [LICENSE](LICENSE).
