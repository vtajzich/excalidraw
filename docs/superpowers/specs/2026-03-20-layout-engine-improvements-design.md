# Layout Engine Improvements Design

**Date:** 2026-03-20
**Status:** Approved
**Scope:** Patch to `patches/layout.ts` and `patches/patch-index-layout.mjs` — six targeted fixes to the existing layout engine

---

## Overview

Six issues were discovered while building a top-down zoned relationship map (~40+ elements, 5 horizontal zones, cross-zone arrows). All fixes are delivered as updates to the existing patch files. No upstream files other than `src/index.ts` are modified.

---

## Issues Addressed

| # | Issue | Priority | Fix |
|---|-------|----------|-----|
| 1 | `create_arrow` obstacle detection misses diagonal paths | High | Exhaustive attachment point search in `routeArrow` |
| 2 | `text` vs `label.text` confusion in API responses | Low | Documentation note in `read_diagram_guide` |
| 3 | `apply_layout` always repositions nodes | High | New `mode: "edges-only"` parameter |
| 4 | `apply_layout` too wide for zone-based diagrams | Medium | New `groups` parameter with Dagre rank constraints |
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
3. If any clear pairs exist → pick the shortest one → 2-point arrow

**Elbow path selection (fallback when no straight path is clear):**
1. For each of the 16 pairs, generate both elbow candidates (horizontal-first and vertical-first) → 32 elbow candidates total
2. For each candidate, count obstacle intersections (excluding source and target bounding boxes)
3. Pick the candidate with fewest intersections; tiebreak: shortest total path length

`nearestMidpointPair` is removed. The 4 side midpoints of each element are computed inline. All callers of `routeArrow` (`handleCreateArrow`, `apply_layout` edge routing, `move_element` rerouting) get the fix automatically.

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

Add `mode?: "layout" | "edges-only"` to the `apply_layout` parameter schema. Default: `"layout"` (existing behavior unchanged).

### Behavior in `"edges-only"` Mode

- Skip `runDagreLayout` entirely — no Dagre, no node repositioning
- Fetch current canvas positions for all elements
- Route only the arrows listed in `edges[]` using the Phase 4 routing algorithm (benefiting from the exhaustive attachment point search from Fix 1)
- `nodes[]` is still accepted but positional — elements listed there plus all other canvas elements are included as obstacles for routing
- Returns `{ updated: N, positions: [] }` — position array is empty since no nodes moved

### Use Case

```
1. Manually place all elements in zone layout
2. Call apply_layout with mode: "edges-only", edges: [...cross-zone-arrow-pairs...]
3. Arrows are routed around obstacles; no element positions change
```

---

## Fix 4 — Zone/Group Rank Constraints in `apply_layout` (Issue #4)

### API Change

Add `groups?: { id: string, memberIds: string[], rank: number }[]` to the `apply_layout` parameter schema. Only used when `mode` is `"layout"` (ignored in `"edges-only"` mode).

### Implementation

Before building the Dagre graph, construct a `nodeRank: Map<string, number>` from `memberId → rank`. When calling `g.setNode(id, { width, height, ... })`, include `rank: nodeRank.get(id)` if the node has a group assignment.

Dagre's `rank` property pins nodes to specific layers, preventing the algorithm from reordering zone members across ranks.

```typescript
// Example usage
groups: [
  { id: "people-zone",  memberIds: ["alice", "bob", "carol"],     rank: 0 },
  { id: "product-zone", memberIds: ["svc-a", "svc-b", "svc-c"],   rank: 1 },
  { id: "epic-zone",    memberIds: ["e-1", "e-2", "e-3"],         rank: 2 },
  { id: "init-zone",    memberIds: ["init-a", "init-b"],          rank: 3 },
  { id: "obj-zone",     memberIds: ["obj-1", "obj-2"],            rank: 4 },
]
```

Nodes not listed in any group are unconstrained — Dagre places them freely. Rank values must be consistent with edge directions; the caller is responsible for assigning ranks that match the graph's topology.

---

## Fix 6 — `move_element` Proximity Detection (Issue #6)

### Root Cause

`handleMoveElement` detects connected arrows via `e.start?.id === id` or `e.end?.id === id`. Arrows created via `batch_create_elements` with manual `points` arrays and no `startElementId`/`endElementId` have no binding fields and are invisible to this scan.

### Fix

Add a second detection pass after the binding scan using coordinate proximity. For each arrow on canvas:

1. Compute the absolute canvas position of the arrow's first point: `{ x: arrow.x + points[0][0], y: arrow.y + points[0][1] }`
2. Compute the absolute canvas position of the arrow's last point: `{ x: arrow.x + points[N-1][0], y: arrow.y + points[N-1][1] }`
3. Check if either point falls within the moved element's bounding box expanded by `gap: 8` (the standard gap used in arrow routing)

Arrows detected by either method (binding or proximity) are merged and deduplicated by ID before the rerouting pass. No arrow is rerouted twice.

---

## Files Modified

| File | Change |
|------|--------|
| `patches/layout.ts` | `routeArrow` — exhaustive attachment point search; `handleApplyLayout` — `mode` + `groups` params; `handleMoveElement` — proximity detection; `read_diagram_guide` string — label.text note |
| `patches/patch-index-layout.mjs` | Schema updates for `mode` and `groups` parameters in `apply_layout` tool definition |

No other files are modified. `src/server.ts` is not touched.

---

## Out of Scope

- Full multi-level obstacle-avoidance routing (the 2-candidate elbow heuristic with exhaustive attachment points is sufficient)
- Modifying `src/server.ts` or any upstream file other than `src/index.ts`
- Changing the internal `label.text` storage format in the Express server
