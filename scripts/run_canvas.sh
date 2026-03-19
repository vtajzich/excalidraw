#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../mcp_excalidraw"

PORT=3000 npm run canvas
