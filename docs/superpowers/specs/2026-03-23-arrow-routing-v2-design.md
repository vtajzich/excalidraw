# Arrow Routing V2 — Obstacle Avoidance, Fan-Out, Spacing & Direction Awareness

**Date:** 2026-03-23
**Status:** Draft
**Builds on:** `2026-03-21-auto-routing-design.md` (Phase 3 lane routing)

## Problem Statement

The current arrow routing system (3-phase: straight → elbow → lane) produces functional paths but fails in common real-world diagram patterns:

1. **Element crossing:** Arrows pass through intermediate elements when side-exit paths exist (e.g., E-3 → Svc-A crosses E-1 and E-2 in the same column)
2. **Endpoint stacking:** Multiple arrows to the same element arrive at the same midpoint, visually overlapping
3. **No edge gap:** Arrows attach at the exact element boundary with 0px breathing room
4. **No shared lanes:** Parallel arrows in the same column find independent paths that nearly-but-not-quite overlap, creating visual noise
5. **Direction blindness:** TB and LR layouts get identical routing behavior; the router doesn't prefer flow-aligned sides

These problems were discovered building a 5-zone relationship map (Team Members → Products → Work Items → Initiatives → Objectives) where every arrow had to be manually computed with a 100+ line Python script.

## Approach

Incremental patches to the existing `routeArrow` function and `apply_layout`/`create_arrow` tool handlers. Each fix is independently testable. The engine auto-computes smart defaults; the tools expose optional override parameters.

## Prerequisites

### `routeArrow` signature migration

The current signature `routeArrow(from: Box, to: Box, obstacles: Box[])` gains a 4th optional parameter:

```typescript
function routeArrow(
  from: Box,
  to: Box,
  obstacles: Box[],
  options?: RouteOptions
): RouteResult
```

All existing call sites (`handleCreateArrow`, `handleApplyLayout`, `handleMoveElement`) continue to work unchanged — `options` defaults to `{}` when omitted.

### Excalidraw binding model

The Excalidraw arrow element already supports `startBinding` and `endBinding` objects with `{ elementId, focus, gap, fixedPoint }` fields. The MCP layer's `CanvasElement` type is a simplified view and does NOT need to be extended — the layout engine operates on raw Excalidraw elements (accessed via `excalidrawAPI.getSceneElements()`), not MCP `CanvasElement` wrappers. Focus and gap values are set directly on the Excalidraw element's binding objects.

### Routing metadata persistence

`exitSide` and `entrySide` from `RouteResult` are transient — they exist only during the routing pass and are NOT persisted on the arrow element. For fan-out grouping (Fix 2), `entrySide` is re-derived at query time by examining the arrow's last path segment direction relative to the target element. This avoids requiring schema changes to the persisted element format.

### Obstacle filtering in `apply_layout`

The current `handleApplyLayout` excludes layout nodes from the obstacle set (line 1141-1143). This must be changed: for arrow routing, ALL elements except the source and target should be obstacles. The fix: pass all positioned elements as obstacles, excluding only the current arrow's source and target. This is a prerequisite for Phase 2.5 to work correctly in `apply_layout`.

## Design

### Fix 1: Side-Exit Obstacle Avoidance (Phase 2.5)

**Where:** `routeArrow` in `patches/layout.ts`

Insert a new phase between elbow (Phase 2) and lane (Phase 3). Runs only when Phase 2 has `crossings > 0`.

**Relationship to Phase 3:** Phase 3 (lane routing) already generates multi-segment paths through gaps, but it selects attachment points from `getSideMidpoints` (center of each side) and tries all 16 side-pairs × all lanes. Phase 2.5 differs in two ways: (1) it **restricts** candidate exits to perpendicular sides only (reducing the search space for clarity), and (2) it constructs paths that exit from the **source side** rather than the source midpoint — producing "comb-style" routing where the arrow visually departs from the element edge. If Phase 2.5 finds a 0-crossing path, Phase 3 is skipped entirely. If not, Phase 3 runs as a broader fallback.

**Algorithm:**

1. Determine candidate exit sides:
   - Compute `dx = abs(target.cx - source.cx)` and `dy = abs(target.cy - source.cy)`
   - If `dy > dx` (vertically-oriented): try left/right exits on source, left/right/top/bottom entries on target
   - If `dx >= dy` (horizontally-oriented): try top/bottom exits on source, all entries on target
   - If `flowDirection` is provided (from Fix 5, or passed by caller), it overrides the dx/dy heuristic: TB → left/right exits, LR → top/bottom exits. When Fix 5 is not yet implemented, the dx/dy heuristic is the sole fallback — Phase 2.5 works without `flowDirection`.
   - If `preferSide` is provided, restrict source exit to that single side
   - If neither `flowDirection` nor clear dx/dy dominance (i.e., `abs(dx - dy) < 20`): try all 4 exit sides (degenerate case)
2. For each (exit-side, entry-side) combination, construct a 3-segment path:
   - Segment 1: horizontal/vertical from source side to a routing lane in the nearest gap
   - Segment 2: through the gap (parallel to the obstacle column/row)
   - Segment 3: horizontal/vertical from the gap to the target side
3. The routing lane coordinate = midpoint of the nearest inter-element gap that is ≥ `MIN_LANE_GAP` (default 20px). Reuses existing gap-detection logic from Phase 3.
4. Score each candidate via `countElbowIntersections`. Select the one with fewest crossings.
5. Use Phase 2.5 result only if it improves on Phase 2's crossing count.

**New phase cascade:**

```
Phase 1:   Straight path search (16 side-pairs) — unchanged
Phase 2:   Elbow routing (32 candidates) — unchanged
Phase 2.5: Side-exit routing (NEW) — only if Phase 2 crossings > 0
Phase 3:   Lane routing — only if Phase 2.5 crossings > 0 (was: Phase 2)
```

**`routeType` return value:** `'side-exit'` (new value added to the union type). Side-exit routes set `elbowed: true` since they produce multi-segment orthogonal paths that Excalidraw should render with sharp corners.

**Self-loops:** When `from === to`, Phase 2.5 is skipped (self-loops fall through to Phase 3 or use the existing elbow result).

### Fix 2: Auto Fan-Out

**Where:** `apply_layout` Phase 4 post-pass; `create_arrow` handler.

#### Level 1: Batch fan-out in `apply_layout`

After all edges are routed in Phase 4, run a fan-out post-pass:

1. Group routed arrows by `(targetElementId, entrySide)`. The `entrySide` is derived from the arrow's routing result: for a straight/elbow path, it is the side of the target element closest to the last path segment's approach direction (top if arriving from above, right if arriving from the right, etc.). For side-exit/lane paths, it is the entry side selected during routing.
2. For each group with N > 1:
   - Sort arrows by source element position (x-coordinate for top/bottom entry, y-coordinate for left/right entry) to maintain spatial coherence.
   - Assign focus values evenly spread from `-0.7` to `+0.7`. Formula: `focus[i] = -0.7 + 1.4 * i / (N - 1)` for N > 1; `focus[0] = 0` for N = 1.
   - Update `endBinding.focus` on each arrow.
   - Recompute endpoint coordinates to match the new focus position.
3. Repeat for `(sourceElementId, exitSide)` groups — spread start points.
4. Re-route affected arrows with focus locked (pass as constraint to `routeArrow`).

**Stability:** Fan-out is a single-pass operation, not iterative. Focus values are computed once from the group size and assigned. The re-route in step 4 does NOT trigger another fan-out pass — focus values are pinned via `startFocus`/`endFocus` options, so the re-route only adjusts waypoints for the new attachment positions. There is no convergence loop and no risk of oscillation.

**Edges-only mode:** Fan-out also applies in `edges-only` mode (`handleEdgesOnly`). After routing all arrows, the same fan-out post-pass runs. This ensures `apply_layout` with `edges_only: true` produces properly spread arrows.

#### Level 2: Incremental fan-out in `create_arrow`

After routing the new arrow:

1. Query existing arrows sharing the same `(targetElementId, entrySide)`.
2. If group size becomes N > 1, re-spread all arrows in the group using the same algorithm.
3. Update existing arrows on the canvas in-place.
4. Return the new arrow's routing metadata as normal.

Calling `create_arrow` N times produces the same fan-out as `apply_layout`.

#### Focus as a routing constraint

`routeArrow` options gain:

```typescript
interface RouteOptions {
  flowDirection?: 'TB' | 'LR';
  startFocus?: number;   // pin start attachment at this focus [-1..1]
  endFocus?: number;     // pin end attachment at this focus [-1..1]
  gap?: number;          // px offset from element edge (default 8)
}
```

When `endFocus` is provided, Phase 1–3 still run to find the best path, but the target attachment point's perpendicular offset is pinned to the given focus value.

#### LLM override

`create_arrow` tool gains optional `startFocus` and `endFocus` parameters (numbers, -1 to 1). When provided, they skip auto fan-out for that arrow and use the explicit values.

### Fix 3: Visible Spacing (Gap Control)

**Where:** `routeArrow`, `create_arrow`, `apply_layout`.

#### When gap is applied:

Gap offset is applied **during attachment point computation**, not as a post-processing step after routing. Specifically:

1. `routeArrow` accepts `gap` option (default 8px).
2. `getAttachmentPoint` (see below) incorporates the gap offset when computing candidate start/end points for all phases. This means Phase 1–3 path searches already use gap-offset coordinates as their endpoints.
3. After the winning path is selected, `startBinding.gap` and `endBinding.gap` are set on the arrow element for Excalidraw's renderer.

This means `fromPt` in the return value already includes the gap offset — it represents the actual rendered start position, not the element boundary.

#### Coordinate adjustment:

For an arrow exiting the right side at `(ex + width, cy)`:
- Attachment point becomes `(ex + width + gap, cy)`

For an arrow entering the bottom at `(cx, ey + height)`:
- Attachment point becomes `(cx, ey + height + gap)`

General rule: offset by `gap` along the outward normal of the attachment side.

#### Utility refactor:

`getSideMidpoints(box)` is retained for backward compatibility but internally delegates to `getAttachmentPoint` with `focus=0` and `gap=0`. All new code uses `getAttachmentPoint` directly.

```typescript
function getAttachmentPoint(
  box: Box,
  side: 'top' | 'bottom' | 'left' | 'right',
  focus: number,  // -1..1 position along the perpendicular axis
  gap: number     // px offset from edge
): Point
```

This consolidates side selection, focus offset, and gap offset into one function.

#### Integration into routing phases:

At the top of `routeArrow`, candidate attachment points are computed once using `getAttachmentPoint` with the provided `gap` and `focus=0` (default). These replace the current `fromPts`/`toPts` arrays from `getSideMidpoints`. When `startFocus` or `endFocus` is provided, the corresponding points use that focus value instead. All four phases (1, 2, 2.5, 3) use these pre-computed points as their search space.

#### Tool parameters:

- `create_arrow`: new optional `gap: number` (default 8)
- `apply_layout`: new optional `spacing.arrowGap: number` (default 8)

### Fix 4: Shared Routing Lanes (Comb/Bus Pattern)

**Where:** Extension of the fan-out post-pass in `apply_layout` Phase 4.

After fan-out assigns spread focus values:

1. **Detect shared-lane groups:** find arrows that:
   - Both use side-exit routing (Phase 2.5 or 3)
   - Both exit from the same side (e.g., both exit right)
   - Their routing lane coordinates are within `LANE_SNAP_THRESHOLD` (default 30px) of each other
   - They target the same element, or elements within the same row/column
2. **Snap to shared lane:** set all lane coordinates in the group to the median value. After snapping, validate that the shared lane coordinate does not intersect any obstacle bounding box. If it does, skip snapping for that group and keep individual lane coordinates.
3. **Result:** arrows share a vertical (or horizontal) spine and branch only at endpoints.

Example for E-1, E-2, E-3 → Svc-A (all column 1, right gap center x=330):

```
E-1 right → x=330 → up → Svc-A right (y=255)
E-2 right → x=330 → up → Svc-A right (y=270)
E-3 right → x=330 → up → Svc-A right (y=285)
```

Shared vertical segment at x=330. Branches only at Svc-A's right edge.

No new LLM-facing parameter. Lane consolidation is automatic. The LLM can bypass it by using `batch_create_elements` with explicit waypoints.

### Fix 5: Direction-Aware Routing

**Where:** Scoring logic throughout all phases of `routeArrow`.

`routeArrow` receives `flowDirection?: 'TB' | 'LR'` in its options.

#### Scoring bias per phase:

**Phase 1 (straight):** When multiple straight paths tie on length, prefer flow-aligned:
- TB: source exits bottom, target enters top
- LR: source exits right, target enters left

**Phase 2 (elbow):** When candidates tie on crossing count, prefer:
- TB: horizontal-first elbows (this is the current hardcoded behavior — no change needed for TB)
- LR: vertical-first elbows (reverses the current hardcoded horizontal-first bias — conditionalize the tie-breaker on `flowDirection`)

**Phase 2.5 (side-exit):** Prefer perpendicular exits:
- TB: prefer left/right exits
- LR: prefer top/bottom exits

**Phase 3 (lane):** Prefer flow-aligned lane axis:
- TB: prefer vertical lanes (x-axis gaps)
- LR: prefer horizontal lanes (y-axis gaps)

#### Propagation:

- `apply_layout`: derives from `direction` param ('top-down' → 'TB', 'left-right' → 'LR'). Passed to every `routeArrow` call.
- `create_arrow`: new optional `flowDirection` param. When omitted, inferred from source/target positions: `|dy| > |dx|` → TB, else LR.
- `move_element`: when re-routing connected arrows after a move, passes `{ flowDirection, gap: DEFAULT_GAP }` to `routeArrow`. `flowDirection` is inferred per arrow via the dx/dy heuristic. `move_element` does NOT perform fan-out recalculation — it only re-routes individual arrows. Fan-out recalculation requires calling `apply_layout` (edges-only mode) after repositioning.

#### Mixed direction:

Each arrow gets its own flow bias based on source/target relative positions. No global state needed.

## Tool API Changes

### `create_arrow` — new optional parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `startFocus` | number (-1..1) | auto | Pin start attachment position along element edge |
| `endFocus` | number (-1..1) | auto | Pin end attachment position along element edge |
| `gap` | number | 8 | Pixel gap between arrowhead and element boundary |
| `flowDirection` | 'TB' \| 'LR' | inferred | Bias routing for top-down or left-right flow |
| `preferSide` | 'left' \| 'right' \| 'top' \| 'bottom' | auto | Hint which side to exit from (overrides flow inference) |

### `apply_layout` — new optional parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `spacing.arrowGap` | number | 8 | Pixel gap between arrowheads and element edges |

`flowDirection` is derived from the existing `direction` parameter.

### `routeArrow` internal — new options interface

```typescript
interface RouteOptions {
  flowDirection?: 'TB' | 'LR';
  startFocus?: number;
  endFocus?: number;
  gap?: number;
  preferSide?: 'left' | 'right' | 'top' | 'bottom';
}
```

### Return type extension

```typescript
interface RouteResult {
  points: Point[];
  elbowed: boolean;
  fromPt: Point;      // start attachment point, includes gap offset
  crossings: number;
  routeType: 'straight' | 'elbow' | 'side-exit' | 'lane';
  exitSide?: 'top' | 'bottom' | 'left' | 'right';   // side arrow exits source
  entrySide?: 'top' | 'bottom' | 'left' | 'right';  // side arrow enters target
  laneAxis?: 'x' | 'y';
  laneCoord?: number;
}
```

New `routeType` value: `'side-exit'`. New fields `exitSide`/`entrySide` are used by fan-out grouping (Fix 2) and lane consolidation (Fix 4).

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `DEFAULT_GAP` | 8 | Default arrow-to-element gap in pixels |
| `MIN_LANE_GAP` | 20 | Minimum inter-element gap to consider as a routing lane |
| `LANE_OUTER_MARGIN` | 40 | Outer lane margin beyond obstacle bounding box |
| `LANE_DEDUP_THRESHOLD` | 5 | Merge lanes within this distance |
| `LANE_SNAP_THRESHOLD` | 30 | Snap nearby lanes to shared coordinate |
| `FAN_OUT_RANGE` | 0.7 | Max focus magnitude for auto fan-out (±0.7) |
| `AXIS_DOMINANCE_THRESHOLD` | 20 | Min px difference between dx/dy to determine axis dominance in Phase 2.5 |

`LANE_OUTER_MARGIN`, `LANE_DEDUP_THRESHOLD`, and `MIN_LANE_GAP` already exist as magic numbers in `layout.ts`. As part of implementation, extract them into named constants at the top of the file to replace the inline values.

## Test Plan

### Unit tests (in `layout.test.ts`)

1. **Phase 2.5 — side-exit:**
   - 3 stacked obstacles in a column; arrow from bottom element to element above all 3 → picks side-exit through right gap with 0 crossings
   - Same scenario mirrored for LR layout (stacked row, exit top/bottom)
   - No obstacles blocking column → Phase 1 straight path still wins (Phase 2.5 not invoked)

2. **Auto fan-out:**
   - 3 arrows to same element bottom → focus values spread to [-0.7, 0, 0.7] (formula: `-0.7 + 1.4 * i / (N-1)`)
   - 4 arrows to same element right → focus values [-0.7, -0.233, 0.233, 0.7], y-positions spread across right side
   - Single arrow → focus stays at 0
   - Incremental: create 3 arrows sequentially → same spread as batch
   - Fan-out does not trigger recursive re-routing (single-pass stability)

3. **Gap control:**
   - Arrow with gap=8 → first/last points offset 8px from element boundary
   - Arrow with gap=0 → points at exact boundary (backward compat)
   - Gap applied correctly for all 4 sides

4. **Lane consolidation:**
   - 3 arrows through same gap → lane coordinates snap to shared value
   - 2 arrows through different gaps (>30px apart) → no snapping

5. **Direction-aware scoring:**
   - TB layout with two equal-length straight paths → prefers bottom→top over left→right
   - LR layout with two equal elbows → prefers vertical-first

6. **Phase 2.5 with `preferSide`:**
   - Source surrounded by obstacles on left/right → `preferSide: 'top'` forces top exit even if dx > dy

7. **Gap + focus interaction:**
   - Arrow with gap=8 and endFocus=0.5 → endpoint offset both along perpendicular axis AND outward from edge

### Integration tests

8. **Example diagram (existing):**
   - Load `docs/example-diagram/example-diagram.excalidraw`
   - Route all epic→svc arrows via `apply_layout` edges-only mode
   - Assert: crossings reduced vs. baseline (ideally 0, but allow ≤ 2 for edge cases)
   - Assert: arrows to svc-d have N distinct endpoint y-values where N = number of arrows (fan-out)

## Implementation Order

Each fix is independently shippable:

1. **Fix 3: Gap control** — smallest change, immediate visual improvement, unblocks other fixes
2. **Fix 5: Direction-aware scoring** — scoring bias only, no structural change
3. **Fix 1: Phase 2.5 side-exit** — biggest algorithmic change, core obstacle avoidance
4. **Fix 2: Auto fan-out** — depends on Fix 3 (gap) for correct endpoint math
5. **Fix 4: Lane consolidation** — depends on Fix 1 (side-exit) and Fix 2 (fan-out)

## Out of Scope

- A* / grid-based pathfinding (unnecessary for typical diagram densities)
- Diagonal routing (only horizontal/vertical segments)
- Arrow label collision avoidance
- Self-loop routing improvements
- Parent render order (upstream API limitation)
