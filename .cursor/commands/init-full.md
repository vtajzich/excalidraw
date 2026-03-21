---
description: Complete setup — clone, build, download libraries, register them in App.tsx, patch MCP tools, and verify.
---

Run full setup for the Excalidraw MCP workspace from scratch.

## Steps

Run the setup script:
```bash
bash scripts/init_full.sh
```

This runs five steps in sequence:

1. **Clone and build** `mcp_excalidraw`
2. **Download** all `.excalidrawlib` icon packs into `library_cache/`
3. **Patch MCP** with `list_libraries` and `list_library_items` tools
4. **Patch MCP** with `apply_layout`, `move_element`, and `create_arrow` tools
5. **Register libraries** in `App.tsx` and rebuild the frontend

All steps are idempotent — safe to re-run on an already-configured workspace.

## Start the canvas server

```bash
bash scripts/run_canvas.sh
```

Open <http://localhost:3000>.
