# Layout Engine Design

**Date:** 2026-03-20
**Status:** Approved
**Scope:** Patch to `mcp_excalidraw` — three new MCP tools backed by a layout engine using Dagre

---

## Overview

Add auto-layout capabilities to the Excalidraw MCP server as a patch. The upstream `mcp_excalidraw` repo is cloned clean and patched at setup time — no upstream files are modified directly, keeping the diff clean for a future upstream PR.

The patch adds three MCP tools:
- `apply_layout` — arrange elements using a configurable layout algorithm
- `move_element` — move an element and automatically reroute its arrows
- `create_arrow` — create a connected arrow between two elements by ID

---

## Architecture

```
AI Agent (MCP client)
  └─ apply_layout / move_element / create_arrow
       └─ src/index.ts (patched) — tool handlers
            └─ src/layout.ts (new) — layout engine
                 ├─ Dagre adapter — node positioning
                 ├─ Containment resolver — parent box sizing
                 └─ Arrow router — straight/elbow routing
                      └─ src/server.ts (unchanged) — batch element updates via HTTP
```

Everything is delivered as patch files in `patches/`. `src/server.ts` is not touched.

---

## Patch Delivery

```
patches/
  layout.ts                # layout engine + tool definitions (copied to src/layout.ts)
  patch-index-layout.mjs   # idempotent patcher for src/index.ts

scripts/
  add_layout_tools.sh      # install dagre + apply patch + rebuild
  init_full.sh             # updated: calls add_layout_tools.sh as step 5
```

`add_layout_tools.sh` steps:
1. `npm install dagre` inside `mcp_excalidraw/`
2. Copy `patches/layout.ts` → `mcp_excalidraw/src/layout.ts`
3. Run `patches/patch-index-layout.mjs`
4. `npm run build:server`

`patch-index-layout.mjs` makes three idempotent edits to `src/index.ts`:
1. Adds `import { layoutTools, handleLayoutTool } from './layout.js';` after existing imports
2. Adds `tools.push(...layoutTools);` after the tools array closing `];`
3. Adds switch cases for `apply_layout`, `move_element`, `create_arrow` before `default:`

---

## Tool APIs

### `apply_layout`

Runs a layout algorithm on canvas elements. Accepts metadata for parent-child relationships, configurable algorithm and spacing.

```typescript
apply_layout({
  algorithm: "hierarchical" | "flow",       // required
  direction: "top-down" | "left-right",     // default: "top-down"
  elementIds?: string[],                    // omit to layout all elements
  nodes: [{
    id: string,                             // element ID on canvas
    parentId?: string,                      // declares containment relationship
    width?: number,                         // hint — falls back to element width
    height?: number,
  }],
  edges: [{
    fromId: string,
    toId: string,
    arrowId?: string,                       // update existing arrow, or create new
  }],
  spacing?: {
    nodeSep?: number,                       // px between sibling nodes (default: 40)
    rankSep?: number,                       // px between ranks/layers (default: 60)
    padding?: number,                       // px inside parent boxes (default: 20)
  }
})
// returns: { updated: number, positions: { id, x, y, width, height }[] }
```

### `move_element`

Moves an element to new absolute coordinates and reroutes its connected arrows.

```typescript
move_element({
  id: string,         // element to move
  x: number,
  y: number,
  arrowIds?: string[] // override: only reroute these arrows
                      // omit = auto-detect all connected arrows
})
// returns: { element: updated element, arrows: updated arrow[] }
```

### `create_arrow`

Creates a routed arrow connecting two existing elements by ID. Simpler interface than `create_element` with type `arrow`.

```typescript
create_arrow({
  fromId: string,
  toId: string,
  label?: string,
  style?: "solid" | "dashed" | "dotted",   // default: "solid"
  startArrowhead?: "arrow" | "dot" | "bar" | null,
  endArrowhead?: "arrow" | "dot" | "bar" | null,  // default: "arrow"
  color?: string,
})
// returns: { id: string, element: created arrow element }
// routing: straight if path is clear, elbow if blocked
```

---

## Layout Engine (`src/layout.ts`)

### Phase 1 — Fetch & Validate

Fetch elements from the Express server. Merge with `nodes[]` metadata — fill missing `width`/`height` from actual element dimensions. Validate that all `parentId` references exist within the element set.

### Phase 2 — Dagre Layout

Build a Dagre graph from `nodes[]` and `edges[]`. Elements with a `parentId` form sub-graphs — Dagre runs on each containment group independently, then group positions are resolved relative to their eventual parent position.

- **Hierarchical mode:** `rankdir: TB` (top-down) or `LR` (left-right). Sugiyama layering with crossing minimisation.
- **Flow mode:** same algorithm; arrow direction drives source→sink ordering.

Output: absolute `{ x, y }` for every node.

### Phase 3 — Containment Resolver (bottom-up)

Walk the parent-child tree leaves-first. For each parent node:

```
parent.x      = min(children.x) - padding
parent.y      = min(children.y) - padding
parent.width  = (max(children.x + width)  - min(children.x)) + 2 * padding
parent.height = (max(children.y + height) - min(children.y)) + 2 * padding
```

Children's absolute positions are then offset to sit inside the parent bounding box. This bottom-up walk ensures nested containment (grandparent wraps parent wraps children) is resolved correctly.

### Phase 4 — Arrow Routing

For each edge in `edges[]`:

1. Compute nearest edge midpoints on source and target elements.
2. **Straight path check:** cast a ray between the two midpoints. If it intersects no other element bounding box (excluding source and target), use a 2-point straight line.
3. **Elbow fallback:** if blocked, try two routing candidates — horizontal-first (exit source right/left, enter target top/bottom) and vertical-first (exit source top/bottom, enter target left/right). Pick whichever candidate has fewer bounding box intersections. Output 3–4 waypoints with `elbowed: true`.
4. Set `startBinding` and `endBinding` with `gap: 8`.
5. Batch-update all modified elements via a single Express API call.

### `move_element` arrow rerouting

1. Update the element's `x`/`y` in the element store.
2. Find all connected arrows: scan elements for `startBinding.elementId === id` or `endBinding.elementId === id`. If `arrowIds` is provided, use only those.
3. Re-run Phase 4 arrow routing for each affected arrow.
4. Batch-update element + arrows in one call.

---

## Dependency

**dagre** (`npm install dagre`) — ~50kb, no transitive dependencies relevant to this use case. Installed inside `mcp_excalidraw/` as part of the patch script. Type definitions via `@types/dagre`.

---

## Out of Scope

- Force-directed layout (no use case identified)
- Multi-level elbow routing with full obstacle avoidance (simple 2-candidate heuristic is sufficient)
- Persistent layout metadata storage (metadata is passed per call)
- Modifying `src/server.ts` or any upstream file other than `src/index.ts`
