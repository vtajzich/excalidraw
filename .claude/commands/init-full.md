---
description: Complete setup — clone, build, download libraries, register them in App.tsx, patch MCP tools, and verify.
---

Run full setup for the Excalidraw MCP workspace from scratch.

## Steps

1. **Clone, build, download libraries, and patch MCP tools**:
   ```bash
   bash scripts/init_full.sh
   ```
   This runs four steps in sequence:
   - Clones `mcp_excalidraw` and builds it
   - Downloads all `.excalidrawlib` icon packs into `library_cache/`
   - Copies them into `mcp_excalidraw/frontend/public/libraries/`
   - Patches the MCP server with `list_libraries` and `list_library_items` tools

2. **Register libraries in App.tsx** — follow the `add-libraries` command to add each library file to the `LIBRARY_FILES` array in `mcp_excalidraw/frontend/src/App.tsx` and rebuild.

3. **Start the canvas server**:
   ```bash
   bash scripts/run_canvas.sh
   ```

Open <http://localhost:3000>.
