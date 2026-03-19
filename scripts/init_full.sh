#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/4] Clone and build mcp_excalidraw"
bash scripts/init.sh

echo ""
echo "==> [2/4] Download icon libraries"
bash scripts/download_libraries.sh

echo ""
echo "==> [3/4] Copy libraries into build"
mkdir -p mcp_excalidraw/frontend/public/libraries
cp library_cache/*.excalidrawlib mcp_excalidraw/frontend/public/libraries/
echo "    Copied $(ls library_cache/*.excalidrawlib | wc -l | tr -d ' ') libraries"

echo ""
echo "==> [4/4] Patch MCP server with list_libraries / list_library_items tools"
bash scripts/add_library_tools.sh

echo ""
echo "==> Done."
echo ""
echo "    Remaining step: register the copied libraries in App.tsx and rebuild."
echo "    Run the /add-libraries command (Claude Code) or add-libraries (Cursor)."
echo ""
echo "    Then start the canvas:"
echo "    bash scripts/run_canvas.sh"
