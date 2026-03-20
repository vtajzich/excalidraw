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
  init_full.sh             # updated: calls add_layout_tools.sh as step 5 (appended after existing step 4)
```

### `add_layout_tools.sh` steps

1. `npm install dagre && npm install --save-dev @types/dagre` inside `mcp_excalidraw/`
2. Copy `patches/layout.ts` → `mcp_excalidraw/src/layout.ts`
3. Run `patches/patch-index-layout.mjs`
4. `npm run build:server`

Note: this script is distinct from `scripts/add_library_tools.sh` (which patches library listing tools). Both scripts are called independently and are idempotent.

### `patch-index-layout.mjs` — anchor strategy

The library tools patch (`patch-index.mjs`) already modified `src/index.ts` by inserting `tools.push(...libraryTools);` after the tools array. The layout patcher must anchor on the post-library-patch state of the file.

Three idempotent edits to `src/index.ts`, all using the same insertion strategy as `patch-index.mjs`: `str.replace(ANCHOR, ANCHOR + '\n' + ADDITION)`.

1. **Import** — guard: check for `from './layout.js'` before applying. Anchor: the exact string `import { libraryTools, handleLibraryTool } from './library-tools.js';`
   ```ts
   import { layoutTools, handleLayoutTool } from './layout.js';
   ```

2. **Tools registration** — guard: check for `layoutTools` before applying. Anchor: the exact string `tools.push(...libraryTools);`
   ```ts
   tools.push(...layoutTools);
   ```

3. **Switch cases** — guard: check for `case 'apply_layout':` before applying. Anchor: insert before `default:` in the main tool dispatch switch (same anchor as library tools patch; case order does not matter).

If `add_library_tools.sh` has not been run first (i.e., neither anchor string 1 nor 2 is present in `src/index.ts`), `patch-index-layout.mjs` exits with a clear error: `"Library tools patch must be applied before layout tools patch"`.

---

## Tool APIs

### `apply_layout`

Runs a layout algorithm on canvas elements. Accepts metadata for parent-child containment, configurable algorithm, direction, and spacing.

```typescript
apply_layout({
  algorithm: "hierarchical" | "flow",      // required
  // "hierarchical": top-down or left-right tree; Dagre rankdir TB or LR
  // "flow": DAG pipeline layout; cycles are a hard error (pre-Dagre topological
  //         sort validates acyclicity before any layout runs)
  direction: "top-down" | "left-right",     // default: "top-down"
  elementIds?: string[],                    // pre-filter: only layout these elements
                                            // omit to layout all canvas elements
                                            // nodes[] is then scoped to this set
  nodes: [{                                 // required; empty array is valid (no-op)
    id: string,                             // element ID on canvas
    parentId?: string,                      // declares containment: parent box will
                                            // be resized to physically contain this node
    width?: number,                         // size hint — falls back to element's actual width
    height?: number,
  }],
  edges: [{                                 // required; empty array is valid (no-op)
    fromId: string,
    toId: string,
    arrowId?: string,                       // update existing arrow — ID returned by
                                            // create_arrow or create_element; omit to
                                            // create a new arrow
  }],
  spacing?: {
    nodeSep?: number,   // passed directly to Dagre nodesep (default: 40)
    rankSep?: number,   // passed directly to Dagre ranksep (default: 60)
    padding?: number,   // px of padding inside parent boxes (default: 20)
  }
})
// returns: { updated: number, positions: { id, x, y, width, height }[] }
// errors follow MCP convention: { content: [{ type: 'text', text: 'Error: ...' }], isError: true }
```

**`nodes[]` and `elementIds` relationship:** `elementIds` is a pre-filter applied first. If `elementIds` is omitted, all canvas elements are eligible. `nodes[]` then provides metadata for the elements you want to include in the layout — elements not mentioned in `nodes[]` are excluded from layout computation but remain on canvas unchanged.

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
// errors follow MCP convention
```

**Arrow auto-detection:** scans all canvas elements for arrows where `el.start?.id === id` or `el.end?.id === id` (the shorthand fields stored in the Express element map, not the resolved `startBinding`/`endBinding` objects).

**Arrow rerouting:** re-runs the full Phase 4 arrow routing algorithm for each affected arrow (not a simple coordinate translation). This ensures arrows avoid other elements even after the move changes the path geometry. Updates are written via parallel `PUT /api/elements/:id` calls.

### `create_arrow`

Creates a routed arrow connecting two existing elements by ID. Simpler interface than `create_element` with `type: 'arrow'`. Returns an `id` that can be passed as `arrowId` in subsequent `apply_layout` edge entries.

```typescript
create_arrow({
  fromId: string,
  toId: string,
  label?: string,
  style?: "solid" | "dashed" | "dotted",          // default: "solid"
  startArrowhead?: "arrow" | "dot" | "bar" | null,
  endArrowhead?: "arrow" | "dot" | "bar" | null,  // default: "arrow"
  color?: string,
})
// returns: { id: string, element: created arrow element }
// routing: straight if path is clear, elbow if blocked
// errors follow MCP convention
```

---

## Layout Engine (`src/layout.ts`)

### Phase 1 — Fetch & Validate

Fetch elements from the Express server. If `elementIds` is provided, filter to that set. Merge with `nodes[]` metadata — fill missing `width`/`height` from actual element dimensions. Validate that all `parentId` references exist within the working element set. Fail fast with a descriptive error if any `id` in `nodes[]` is not found on canvas.

### Phase 2 — Dagre Layout (two-pass for containment)

Dagre is run twice to avoid the circular dependency between child positions and parent sizes:

**Pass A — children first:**
For each unique `parentId` group, build a Dagre sub-graph of the children only (not the parent node itself). Run Dagre with `nodesep`/`ranksep` from `spacing`. Record each child's relative position within its group (`x_rel`, `y_rel` from Dagre output).

**Pass B — top-level graph:**
Compute each parent's size from its children's bounding box (max child x+width − min child x, plus 2×padding). Build the top-level Dagre graph with all root nodes (nodes without `parentId`) plus each parent node using its now-correct computed size. Run Dagre to determine inter-node spacing and relative ordering of the top-level elements. The Dagre-assigned `x,y` for parent nodes is used only to derive relative spacing between parents — **final absolute `x,y` of each parent box is always set by Phase 3** (from the children's bounding box), not by Dagre.

**Final position resolution:**
For each parent: offset its children's relative positions by `parent.x + padding`, `parent.y + padding` to produce absolute canvas coordinates. Children are placed first; the parent box is then sized and positioned around them.

**Algorithm modes:**
- **Hierarchical:** `rankdir: TB` or `LR`. Standard Sugiyama layering with crossing minimisation.
- **Flow:** same Dagre call with the same `rankdir`, but back-edges (cycles) are not promoted to earlier ranks — they are flagged as errors. Flow mode assumes a true DAG.

### Phase 3 — Containment Resolver

After Phase 2 resolves absolute positions:

```
parent.x      = min(children.x) - padding
parent.y      = min(children.y) - padding
parent.width  = (max(children.x + child.width)  - min(children.x)) + 2 * padding
parent.height = (max(children.y + child.height) - min(children.y)) + 2 * padding
```

Processed bottom-up (leaves first) so nested containment (grandparent wraps parent wraps children) resolves correctly. Parent render order is set lower than children by assigning the parent a lower `index` fractional string than its children, so children render on top. (`zIndex` does not exist on `ServerElement`; Excalidraw controls render order via the `index` field.)

### Phase 4 — Arrow Routing

For each edge in `edges[]` (and for `create_arrow` and `move_element` rerouting):

1. **Edge midpoints:** compute the midpoint of each side (top, bottom, left, right) of the source and target bounding boxes. Pick the pair of midpoints (one from each element) that are closest to each other as default attachment points.

2. **Straight path check:** cast a ray between the two midpoints. If it does not intersect the bounding box of any other element (excluding source and target), use a 2-point straight line.

3. **Elbow fallback:** try two candidates:
   - **Horizontal-first:** exit source from right or left midpoint → go horizontally to target's x midpoint → go vertically to target attachment point
   - **Vertical-first:** exit source from top or bottom midpoint → go vertically to source's y midpoint → go horizontally to target attachment point

   Count bounding box intersections for each candidate (excluding source and target). Pick the candidate with fewer intersections. Tiebreaker: prefer horizontal-first. Secondary tiebreaker: shorter total path length.

   Output 3–4 waypoints with `elbowed: true`.

4. **Coordinate space:** all `points[]` are stored relative to the arrow's own `x, y` origin (which is the absolute canvas position of the start point). Concretely:
   ```
   arrow.x = startPoint.x
   arrow.y = startPoint.y
   arrow.points = [[0, 0], [wp1.x - startPoint.x, wp1.y - startPoint.y], ..., [endPoint.x - startPoint.x, endPoint.y - startPoint.y]]
   ```

5. **Bindings:** set `start: { id: fromId }` and `end: { id: toId }` (shorthand format used by Express element store) with `gap: 8`. Also update `boundElements` on source and target elements: add `{ type: 'arrow', id: arrowId }` to each if not already present.

6. **Updates:** all modified elements (repositioned nodes + rerouted arrows + updated parent boxes + updated `boundElements`) are written via parallel `PUT /api/elements/:id` calls — one per modified element. There is no batch-update endpoint on the Express server (`POST /api/elements/batch` is create-only; `POST /api/elements/sync` is destructive). Parallel calls are used for throughput; the layout engine awaits `Promise.all([...])` before returning results.

---

## Dependency

**dagre** + **@types/dagre** — installed inside `mcp_excalidraw/` as part of `add_layout_tools.sh`. `dagre` is a runtime dependency; `@types/dagre` is a devDependency for TypeScript compilation. Dagre's coordinate output is in the same unit space as its input node sizes (pixels), so values are used as-is without scaling.

---

## Error Handling

All three tools follow the existing MCP error convention:
```json
{ "content": [{ "type": "text", "text": "Error: <message>" }], "isError": true }
```

Common error cases to handle:
- Element ID not found on canvas
- `parentId` references an ID not in the working set
- Cycle detected in `flow` mode: detected via pre-Dagre topological sort (DFS); returns error immediately before any layout runs
- Arrow auto-detection in `move_element` finds no connected arrows (not an error — return empty `arrows: []`)

---

## Out of Scope

- Force-directed layout
- Full multi-level obstacle-avoidance routing (simple 2-candidate heuristic is sufficient)
- Persistent layout metadata storage (metadata is passed per call)
- Modifying `src/server.ts` or any upstream file other than `src/index.ts`
- Running the layout patch before the library tools patch (dependency is enforced by the patcher)
