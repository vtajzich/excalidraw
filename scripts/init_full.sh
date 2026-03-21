#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/5] Clone and build mcp_excalidraw"
bash scripts/init.sh

echo ""
echo "==> [2/5] Download icon libraries"
bash scripts/download_libraries.sh

echo ""
echo "==> [3/5] Patch MCP server with list_libraries / list_library_items tools"
bash scripts/add_library_tools.sh

echo ""
echo "==> [4/5] Patch MCP server with layout tools (apply_layout, move_element, create_arrow)"
bash scripts/add_layout_tools.sh

echo ""
echo "==> [5/5] Register libraries in App.tsx and rebuild frontend"
bash scripts/register_libraries.sh

echo ""
echo "==> Done. Start the canvas server:"
echo "    bash scripts/run_canvas.sh"
