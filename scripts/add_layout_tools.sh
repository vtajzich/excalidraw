#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dagre dependency"
cd mcp_excalidraw
npm install dagre
npm install --save-dev @types/dagre
cd ..

echo "==> Copying layout.ts into mcp_excalidraw/src/"
cp patches/layout.ts mcp_excalidraw/src/layout.ts

echo "==> Patching mcp_excalidraw/src/index.ts"
node patches/patch-index-layout.mjs

echo "==> Rebuilding MCP server"
cd mcp_excalidraw && npm run build:server

echo "==> Done. Restart the MCP server to activate the new tools:"
echo "    apply_layout"
echo "    move_element"
echo "    create_arrow"
