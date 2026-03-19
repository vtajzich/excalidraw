# Excalidraw MCP Workspace

Wrapper repo for running [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) locally with pre-configured icon libraries. The upstream repo is cloned at setup time and kept out of version control — this repo tracks only the scripts, Cursor commands, and configuration needed to bootstrap and run it.

## Prerequisites

- Node.js >= 18
- npm
- git

## Quick Start

```bash
# 1. Clone and build the upstream repo
bash scripts/init.sh

# 2. Download icon libraries
bash scripts/download_libraries.sh

# 3. Copy libraries into the build
cp library_cache/*.excalidrawlib mcp_excalidraw/frontend/public/libraries/

# 4. Register the libraries in App.tsx and rebuild (see Cursor commands below)

# 5. Start the canvas server
bash scripts/run_canvas.sh
```

Open <http://localhost:3000>.

## Scripts

| Script | What it does |
|---|---|
| `scripts/init.sh` | Clones `mcp_excalidraw`, runs `npm ci` and `npm run build`. Safe to re-run — skips clone if the directory already exists. |
| `scripts/download_libraries.sh` | Downloads `.excalidrawlib` icon packs into `library_cache/`. Skips already-cached files. |
| `scripts/run_canvas.sh` | Starts the Excalidraw canvas server on port 3000. |

## Cursor Commands

These live in `.cursor/commands/` and are available from Cursor's command palette.

| Command | Purpose |
|---|---|
| `init` | Full setup — clone, install, build, patch libraries. |
| `download-libraries` | Download icon libraries into `library_cache/`. |
| `add-libraries` | Copy cached libraries into the build, register them in `App.tsx`, and rebuild. Also documents available libraries and how to add new ones. |

## Project Structure

```
.
├── scripts/
│   ├── init.sh                  # Clone + build upstream repo
│   ├── download_libraries.sh    # Fetch .excalidrawlib files
│   └── run_canvas.sh            # Start canvas server
├── .cursor/
│   └── commands/
│       ├── init.md              # Setup command
│       ├── download-libraries.md
│       └── add-libraries.md
├── library_cache/               # Downloaded .excalidrawlib files (git-ignored)
├── mcp_excalidraw/              # Cloned upstream repo (git-ignored)
├── .gitignore
└── README.md
```

## Adding New Libraries

1. Find a `.excalidrawlib` URL from the [Excalidraw libraries catalog](https://libraries.excalidraw.com).
2. Add the URL to `scripts/download_libraries.sh`.
3. Run `bash scripts/download_libraries.sh`.
4. Copy the file and register it — see the `add-libraries` Cursor command for details.
