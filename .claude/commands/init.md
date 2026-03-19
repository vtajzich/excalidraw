---
description: Full setup — clone, install, build, patch libraries.
---

Initialize the mcp_excalidraw project.

## Steps

1. Run the init script to clone and build the repository:
   ```bash
   bash scripts/init.sh
   ```
2. After the script completes, apply the library patches described in the add-libraries command — download each listed `.excalidrawlib` file and register it in `LIBRARY_FILES`.
3. Rebuild after patching:
   ```bash
   cd mcp_excalidraw && npm run build
   ```
