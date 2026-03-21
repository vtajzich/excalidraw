#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Copying libraries into build"
mkdir -p mcp_excalidraw/frontend/public/libraries
cp library_cache/*.excalidrawlib mcp_excalidraw/frontend/public/libraries/
echo "    Copied $(ls library_cache/*.excalidrawlib | wc -l | tr -d ' ') libraries"

echo "==> Registering libraries in App.tsx"
node patches/patch-app-libraries.mjs

echo "==> Rebuilding frontend"
cd mcp_excalidraw && npm run build:frontend

echo "==> Done."
