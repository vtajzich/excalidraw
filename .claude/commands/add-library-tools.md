---
description: Patch the MCP server with list_libraries and list_library_items tools, then rebuild.
---

Add library browsing tools to the MCP server so an AI agent can discover and browse icon libraries.

## Steps

1. Copy the library tools module into the MCP server source:
   ```bash
   cp patches/library-tools.ts mcp_excalidraw/src/library-tools.ts
   ```

2. Apply the idempotent patch to `mcp_excalidraw/src/index.ts`:
   ```bash
   node patches/patch-index.mjs
   ```

3. Rebuild the MCP server:
   ```bash
   cd mcp_excalidraw && npm run build:server
   ```

After completing these steps, restart the MCP server. You can then call:
- `list_libraries` — see all available icon libraries in `library_cache/`
- `list_library_items` with a library name — browse icons within a library

This command is idempotent: re-running it is safe and will not duplicate patches.
