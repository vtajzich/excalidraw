# Excalidraw MCP Workspace

Wrapper repo for running [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) locally with pre-configured icon libraries. The upstream repo is cloned at setup time and kept out of version control — this repo tracks only the scripts, patches, Cursor/Claude Code commands, and configuration needed to bootstrap and run it.

The upstream MCP server is patched after each clone to add two tools missing from the original: `list_libraries` (discover available icon libraries) and `list_library_items` (browse items in a specific library by name and index). Without these, an AI agent has no way to know which icons exist — it can only guess. The patch is applied automatically during setup and is safe to re-run.

## Prerequisites

- Node.js >= 18
- npm
- git

## Quick Start

### Option A — one command (recommended)

```bash
bash scripts/init_full.sh
```

Then register the libraries in `App.tsx` using the `/add-libraries` Claude Code command or the `add-libraries` Cursor command, and start the canvas:

```bash
bash scripts/run_canvas.sh
```

Open <http://localhost:3000>.

### Option B — step by step

```bash
# 1. Clone mcp_excalidraw, install dependencies, and build
bash scripts/init.sh

# 2. Download icon libraries into library_cache/
bash scripts/download_libraries.sh

# 3. Copy libraries into the build
cp library_cache/*.excalidrawlib mcp_excalidraw/frontend/public/libraries/

# 4. Register each library in App.tsx LIBRARY_FILES array and rebuild
#    → run /add-libraries (Claude Code) or add-libraries (Cursor)

# 5. Patch the MCP server with list_libraries / list_library_items tools
bash scripts/add_library_tools.sh

# 6. Start the canvas server
bash scripts/run_canvas.sh
```

Open <http://localhost:3000>.

## Scripts

| Script | What it does |
|---|---|
| `scripts/init_full.sh` | Runs all setup steps in order: clone, download libraries, copy into build, patch MCP tools. |
| `scripts/init.sh` | Clones `mcp_excalidraw`, runs `npm ci` and `npm run build`. Safe to re-run — skips clone if already exists. |
| `scripts/download_libraries.sh` | Downloads `.excalidrawlib` icon packs into `library_cache/`. Skips already-cached files. |
| `scripts/add_library_tools.sh` | Patches the MCP server with `list_libraries` and `list_library_items` tools, then rebuilds. |
| `scripts/run_canvas.sh` | Starts the Excalidraw canvas server on port 3000. |

## Cursor Commands

These live in `.cursor/commands/` and are available from Cursor's command palette.

| Command | Purpose |
|---|---|
| `init-full` | Complete setup in one go — runs all steps below in order. |
| `init` | Clone `mcp_excalidraw`, install dependencies, and build. |
| `download-libraries` | Download icon libraries into `library_cache/`. |
| `add-libraries` | Copy cached libraries into the build, register them in `App.tsx`, and rebuild. |
| `add-library-tools` | Patch the MCP server with `list_libraries` and `list_library_items` tools, then rebuild. |

## Claude Code Commands

These live in `.claude/commands/` and are available as `/slash-commands` in Claude Code chat.

| Command | Purpose |
|---|---|
| `/init-full` | Complete setup in one go — runs all steps below in order. |
| `/init` | Clone `mcp_excalidraw`, install dependencies, and build. |
| `/download-libraries` | Download icon libraries into `library_cache/`. |
| `/add-libraries` | Copy cached libraries into the build, register them in `App.tsx`, and rebuild. |
| `/add-library-tools` | Patch the MCP server with `list_libraries` and `list_library_items` tools, then rebuild. |

## MCP Setup

First start the canvas server:
```bash
bash scripts/run_canvas.sh
```

Then open `http://localhost:3000` in a browser.

### Claude Code

```bash
claude mcp add excalidraw --scope user \
  -e EXPRESS_SERVER_URL=http://localhost:3000 \
  -e ENABLE_CANVAS_SYNC=true \
  -- node /path/to/excalidraw/mcp_excalidraw/dist/index.js
```

### Claude Desktop

Config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw/mcp_excalidraw/dist/index.js"],
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true"
      }
    }
  }
}
```

### Cursor

Config file: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw/mcp_excalidraw/dist/index.js"],
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true"
      }
    }
  }
}
```

### Codex CLI

```bash
codex mcp add excalidraw \
  --env EXPRESS_SERVER_URL=http://localhost:3000 \
  --env ENABLE_CANVAS_SYNC=true \
  -- node /path/to/excalidraw/mcp_excalidraw/dist/index.js
```

---

## Patching the MCP Server

The upstream `mcp_excalidraw` repo is cloned and built locally but not committed here — it's treated as a build artifact and always reconstructed from scratch. This means we can safely patch it after setup without creating merge conflicts or tracking upstream changes.

### Why patch?

The upstream MCP server has no tools to inspect what icon libraries are available or what items they contain. Without this, an AI agent has no way to know which libraries exist or which icons to use — it can only guess. The patch adds two tools that close this gap:

| Tool | What it does |
|---|---|
| `list_libraries` | Returns all `.excalidrawlib` files in the local cache with name, item count, and keyword description |
| `list_library_items` | Returns every item in a specific library with its index, name, and bounding box dimensions |

With these tools, an agent can discover available libraries, browse their contents, and pick the right icons by name and index before placing them on the canvas — no guessing required.

### How it works

The patch consists of two files in `patches/`:

- `library-tools.ts` — implements the two MCP tools as a self-contained TypeScript module
- `patch-index.mjs` — a Node.js script that injects an import and registration call into `src/index.ts`

After patching, `npm run build` recompiles the server with the new tools included.

### Apply the patch

```bash
bash scripts/add_library_tools.sh
```

This is idempotent — re-running it is safe. The `init` command/script runs this automatically as part of the full setup.

### Example: listing libraries

```
list_libraries()

→ 18 libraries:
  aws-serverless-icons-v2  (24 items)  Lambda, AppSync, APIGateway, DynamoDB, S3 ...
  gcp-icons                (83 items)  Google Cloud Platform icons
  kubernetes-icons-set     (19 items)  RoleBinding, ServiceAccount, PVC, Namespace ...
  hashicorp                 (8 items)  Vagrant, Packer, Nomad, Consul, Vault, Terraform
  ... (14 more)
```

### Example: listing items in the AWS library

```
list_library_items("aws-serverless-icons-v2")

→ 24 items:
   0  Lambda              102 × 92
   1  AppSync             100 × 90
   2  APIGateway          108 × 106
   3  DynamoDB             82 × 112
   4  Aurora               72 × 112
   5  EventBridge          93 × 111
   6  SQS                  96 × 89
   7  SNS                  96 × 94
   8  S3                   86 × 94
   9  CloudFront           84 × 109
  10  SES                  96 × 93
  11  CloudWatch          121 × 110
  12  StepFunctions       116 × 112
  13  Amplify              94 × 91
  14  Cognito             114 × 114
  15  Kinesis             131 × 88
  16  EFS                 123 × 86
  17  WAF                  73 × 92
  18  VTL-resolver         65 × 104
  19  JavaScript-resolver  85 × 104
  20  AWS CodePipeline     92 × 113
  21  AWS CloudTrail       80 × 110
  22  Amazon Route 53      75 × 109
  23  EventBridge Pipe     92 × 104
```

---

## Adding New Libraries

1. Find a `.excalidrawlib` URL from the [Excalidraw libraries catalog](https://libraries.excalidraw.com).
2. Add the URL to `scripts/download_libraries.sh`.
3. Run `bash scripts/download_libraries.sh`.
4. Copy the file and register it — see the `add-libraries` Cursor command for details.
