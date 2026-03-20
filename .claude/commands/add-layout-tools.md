---
description: Patch the MCP server with apply_layout, move_element, and create_arrow tools, then rebuild.
---

Add layout engine tools to the MCP server.

## Steps

1. Install dagre and apply the layout tools patch:
   ```bash
   bash scripts/add_layout_tools.sh
   ```

2. Restart the MCP server. You can then call:
   - `apply_layout` — arrange elements using hierarchical or flow layout with containment
   - `move_element` — move an element and reroute its connected arrows
   - `create_arrow` — create a routed arrow between two elements by ID

This command is idempotent: re-running it is safe and will not duplicate patches.
