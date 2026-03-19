#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Copying library-tools.ts into mcp_excalidraw/src/"
cp patches/library-tools.ts mcp_excalidraw/src/library-tools.ts

echo "==> Patching mcp_excalidraw/src/index.ts"
node patches/patch-index.mjs

echo "==> Rebuilding MCP server"
cd mcp_excalidraw && npm run build:server

echo "==> Done. Restart the MCP server to activate the new tools:"
echo "    list_libraries"
echo "    list_library_items"
