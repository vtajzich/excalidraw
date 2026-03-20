# Layout Engine Improvements Design

**Date:** 2026-03-20
**Status:** Approved
**Scope:** Patch to `patches/layout.ts` — six targeted fixes to the existing layout engine

---

## Overview

Six issues were discovered while building a top-down zoned relationship map (~40+ elements, 5 horizontal zones, cross-zone arrows). All fixes are delivered as updates to the existing `patches/layout.ts`. No upstream files other than `src/index.ts` are modified. `patches/patch-index-layout.mjs` is not changed — all schema updates go in the `layoutTools` array in `patches/layout.ts`.

---

## Issues Addressed

| # | Issue | Priority | Fix |
|---|-------|----------|-----|
| 1 | `create_arrow` obstacle detection misses diagonal paths | High | Exhaustive attachment point search in `routeArrow` |
| 2 | `text` vs `label.text` confusion in API responses | Low | Documentation note in `read_diagram_guide` |
| 3 | `apply_layout` always repositions nodes | High | New `mode: "edges-only"` parameter |
| 4 | `apply_layout` too wide for zone-based diagrams | Medium | New `groups` parameter with post-process y-snap |
| 5 | `create_arrow` dashed + routing fallback | Medium | Automatic cascade from issue #1 fix |
| 6 | `move_element` misses unbound arrows | Low | Coordinate proximity detection fallback |

---

## Fix 1 — Exhaustive Attachment Point Search (`routeArrow`)

### Root Cause

`routeArrow` calls `nearestMidpointPair()` to select one pair of side midpoints (the geometrically closest pair between source and target), then checks if the straight line between those two points intersects any obstacle. For cross-zone arrows in a dense column grid, the nearest pair is typically top/bottom midpoints. The diagonal straight line between them passes through column gaps, so `segmentIntersectsBox` returns false even when the visual path is clearly blocked.

### Fix

Replace `nearestMidpointPair` with exhaustive search over all 16 candidate pairs (4 sides of source × 4 sides of target):

**Straight path selection:**
1. For each of the 16 pairs, run the existing `segmentIntersectsBox` straight-line check against all obstacles
2. Collect all clear pairs
3. If any clear pairs exist → pick the shortest (Euclidean distance between attachment points); if multiple pairs have equal length, pick the first in iteration order (top, right, bottom, left for each element)
4. Use that pair → 2-point arrow

**Elbow path selection (fallback when no straight path is clear):**
1. For each of the 16 pairs, generate both elbow candidates (horizontal-first and vertical-first) → 32 elbow candidates total
2. For each candidate, count obstacle bounding box intersections (excluding source and target)
3. Pick the candidate with fewest intersections
4. Tiebreak 1: prefer horizontal-first (preserves current behavior)
5. Tiebreak 2: if still tied, prefer shortest total path length
6. If still tied, pick first in iteration order

`nearestMidpointPair` is removed. The 4 side midpoints of each element are computed inline as:
```
top:    { x: cx,         y: el.y }
right:  { x: el.x + el.width, y: cy }
bottom: { x: cx,         y: el.y + el.height }
left:   { x: el.x,       y: cy }
```
where `cx = el.x + el.width/2`, `cy = el.y + el.height/2`.

All callers of `routeArrow` (`handleCreateArrow`, `apply_layout` edge routing, `move_element` rerouting) get the fix automatically.

### Cascade: Issue #5

`create_arrow` with `style: "dashed"` + elbow routing is automatically fixed — no separate work.

---

## Fix 2 — `read_diagram_guide` Documentation (Issue #2)

The `text` → `label.text` mapping is correct behavior. The Express server stores text content under `label.text`; this is not a bug. The confusion arises because the guide says "use `text`" for creation (correct) but `describe_scene` and `get_element` return `label.text` (also correct, just undocumented).

**Fix:** Add one sentence to the `read_diagram_guide` tool output:

> "Text content passed as `text` during element creation is stored and returned as `label.text` — this is expected and the text renders correctly inside the shape."

No logic changes. The patch updates the string constant returned by the `read_diagram_guide` handler in `layout.ts`.

---

## Fix 3 — `apply_layout` Edges-Only Mode (Issue #3)

### API Change

Add `mode?: "layout" | "edges-only"` to the `apply_layout` parameter schema in `layoutTools`. Default: `"layout"` (existing behavior unchanged).

### Behavior in `"edges-only"` Mode

- Skip `runDagreLayout` entirely — no Dagre, no node repositioning
- Fetch current canvas positions for all elements
- **Obstacle list (per-edge):** for each edge, build an obstacle list of all non-arrow canvas elements excluding `fromId` and `toId` of that edge (same per-edge construction as `handleCreateArrow`). A separate obstacle list is built per edge — `nodes[]` is accepted but not used to build the obstacle list; it is silently ignored in this mode
- Route the arrows listed in `edges[]` using the Phase 4 routing algorithm (with the exhaustive attachment point search from Fix 1)
- **`arrowId` absent in an edge entry:** create a new arrow, same as existing `"layout"` mode behavior
- Returns `{ updated: N, positions: [] }` where `N` is the total count of arrows created or updated (both `postElement` for new arrows and `putElement` for existing ones are included in `N`); `positions` is always empty since no nodes moved

### Use Case

```
1. Manually place all elements in zone layout
2. Call apply_layout with mode: "edges-only", edges: [...{fromId, toId, arrowId?}...]
3. Arrows are routed around all canvas obstacles; no element positions change
```

---

## Fix 4 — Zone/Group Rank Constraints in `apply_layout` (Issue #4)

### API Change

Add `groups?: { id: string, memberIds: string[], rank: number }[]` to the `apply_layout` parameter schema in `layoutTools`. Only used when `mode` is `"layout"` (silently ignored in `"edges-only"` mode).

### Implementation — Post-Process Y-Snap (not Dagre rank input)

**Why not Dagre `rank` input:** The standard `dagre` npm package does not guarantee that `rank` passed to `g.setNode()` is honored as a positional constraint — it is an internal output field, not a documented input. Setting it on input nodes may be silently ignored.

**Approach instead: run Dagre normally for x-ordering, then snap y-positions by zone rank.**

After `runDagreLayout` returns positions:

1. Build a `memberRank: Map<string, number>` from `groups[]`
2. For each node that has a group assignment, discard Dagre's y value
3. Compute zone y-offsets:
   - Sort distinct rank values ascending: `[0, 1, 2, ...]`
   - For each rank, the zone y-offset = `sum of (maxHeight of all zones with lower rank + ranksep)`
   - `maxHeight` of a zone = max `height` across all nodes assigned to that rank
4. Assign `y = zoneYOffset[nodeRank]` for all grouped nodes (top-left y, same as Dagre's output convention)
5. Ungrouped nodes keep Dagre's y output unchanged

This guarantees all members of the same zone share the same y-coordinate regardless of Dagre's cross-minimization decisions, producing horizontal bands. Dagre's x-output is still used to determine the horizontal ordering of nodes within each zone.

### Validation

- `memberId` not found in `nodes[]` → ignore silently (caller may include superfluous members)
- `rank` must be a non-negative integer; fractional or negative values → return error
- Multiple `groups` entries with the same `rank` → allowed (they form one zone)
- Same `memberId` in two groups → error: `"memberId <id> appears in multiple groups"`
- `groups` provided in `"edges-only"` mode → silently ignored (not an error)
- A `memberId` that also has `parentId` set in `nodes[]` → error: `"groups member <id> is a child node; groups only supports root-level nodes"`. Zone constraints operate on the top-level Dagre graph only; applying y-snap to child nodes would break parent containment.

### Example

```typescript
groups: [
  { id: "people-zone",  memberIds: ["alice", "bob", "carol"],     rank: 0 },
  { id: "product-zone", memberIds: ["svc-a", "svc-b", "svc-c"],   rank: 1 },
  { id: "epic-zone",    memberIds: ["e-1", "e-2", "e-3"],         rank: 2 },
  { id: "init-zone",    memberIds: ["init-a", "init-b"],          rank: 3 },
  { id: "obj-zone",     memberIds: ["obj-1", "obj-2"],            rank: 4 },
]
```

---

## Fix 6 — `move_element` Proximity Detection (Issue #6)

### Root Cause

`handleMoveElement` detects connected arrows via `e.start?.id === id` or `e.end?.id === id`. Arrows created via `batch_create_elements` with manual `points` arrays and no `startElementId`/`endElementId` have no binding fields and are invisible to this scan.

### Fix

Proximity detection runs **only in auto-detect mode** (when `args.arrowIds` is not provided). When `args.arrowIds` is explicitly provided, only those arrows are used — proximity detection does not run.

In auto-detect mode, after the binding-based scan, perform a second pass over all canvas arrows:

1. Compute the absolute canvas position of the arrow's first point: `{ x: arrow.x + points[0][0], y: arrow.y + points[0][1] }`
2. Compute the absolute canvas position of the arrow's last point: `{ x: arrow.x + points[N-1][0], y: arrow.y + points[N-1][1] }`
3. Expand the moved element's bounding box by `gap: 8` on all sides (matching the standard gap used in arrow binding — arrows with manual points are typically placed at the element edge ± this tolerance)
4. If either endpoint falls within the expanded box, include the arrow

Arrows detected by either method are merged and deduplicated by arrow ID before the rerouting pass. No arrow is rerouted twice.

### Rerouting Proximity-Detected Arrows (no binding fields)

Proximity-detected arrows have no `start?.id` / `end?.id` fields, so the existing `routeArrow(from, to, ...)` call cannot be used directly.

**Instead, use a translation approach:**

1. Determine the "attached" endpoint: whichever of first/last absolute point is geometrically closer to the moved element's center
2. Compute the displacement delta: `dx = newX - oldX`, `dy = newY - oldY` (the same delta applied to the moved element)
3. Shift the attached endpoint. Excalidraw stores `arrow.x, arrow.y` as the absolute canvas position of `points[0]` (the first point), and all other `points[i]` as offsets relative to that origin. `points[0]` is always `[0, 0]`. Two cases:

   **If `points[0]` is the attached endpoint (first point is near the moved element):**
   - `arrow.x += dx`, `arrow.y += dy`
   - For each `i` from 1 to N-1: `points[i][0] -= dx`, `points[i][1] -= dy`
   - `points[0]` remains `[0, 0]`

   **If `points[N-1]` is the attached endpoint (last point is near the moved element):**
   - `points[N-1][0] += dx`, `points[N-1][1] += dy`
   - `arrow.x`, `arrow.y`, and all other points are unchanged

4. Do not reroute intermediate waypoints

**Double-proximity edge case (check this first, before the single-endpoint tiebreaker above):** If both `points[0]` and `points[N-1]` fall within the moved element's expanded bounding box (e.g., a self-loop on a large element), apply both transformations — shift `arrow.x, arrow.y` by `(dx, dy)` and leave all `points` values unchanged (equivalent to translating the entire arrow). This preserves the arrow's shape and keeps both endpoints attached to the moved element.

Binding-detected arrows continue to use the existing full `routeArrow` path (they have explicit from/to element IDs).

This is intentionally simpler than a full reroute: the arrow moves with the element, preventing visual disconnection. Full obstacle-avoiding reroute is only applied to bound arrows where from/to element IDs are known.

---

## Files Modified

| File | Change |
|------|--------|
| `patches/layout.ts` | `routeArrow` — exhaustive attachment point search, remove `nearestMidpointPair`; `handleApplyLayout` — `mode` + `groups` params + edges-only path + zone y-snap; `handleMoveElement` — proximity detection in auto-detect path; `read_diagram_guide` string — label.text note; `layoutTools` array — schema updates for `mode` and `groups` |

`patches/patch-index-layout.mjs` is **not modified** — all schema changes go in the `layoutTools` array in `patches/layout.ts`. `src/server.ts` is not touched.

---

## Out of Scope

- Full multi-level obstacle-avoidance routing (the 2-candidate elbow heuristic with exhaustive attachment points is sufficient)
- Modifying `src/server.ts` or any upstream file other than `src/index.ts`
- Changing the internal `label.text` storage format in the Express server
- Dagre `rank` input constraints (replaced by post-process y-snap)
