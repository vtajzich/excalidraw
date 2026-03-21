# Auto-Routing Design: Phase 3 Lane Routing + LLM Guidance

**Date:** 2026-03-21
**Status:** Draft

## Problem

When an arrow must span multiple zones (e.g., Initiative → Product crossing the Work Items zone), `routeArrow` currently produces a diagonal or partially-crossing path. The root cause: `routeArrow` only tries straight lines (Phase 1) and 2-segment L-elbows (Phase 2). When every 2-segment elbow still crosses elements, it returns the "least bad" option rather than routing around the obstacle cluster.

The secondary problem: the LLM has no signal to know whether `create_arrow` produced a clean route, and no documented fallback strategy for when it doesn't.

## Solution Overview (Approach B)

Three coordinated changes:

1. **Algorithm** — add Phase 3 (lane routing) to `routeArrow`: gap-lane detection and 3-segment routing
2. **Feedback** — extend `create_arrow` and `apply_layout` responses with routing metadata
3. **Guidance** — update tool descriptions and `read_diagram_guide` with routing strategy

## File Locations

The codebase has two files that must always be kept in sync:

- **`patches/layout.ts`** — source of truth for all layout logic, including `routeArrow`, `handleCreateArrow`, `handleApplyLayout`, and `handleEdgesOnly`. All algorithm and response changes go here.
- **`mcp_excalidraw/src/layout.ts`** — mirror of the above, updated at build time.

Tool definitions for `batch_create_elements` and the `read_diagram_guide` resource (including the `DIAGRAM_DESIGN_GUIDE` constant) live in **`mcp_excalidraw/src/index.ts`**. Description and guide updates go in `index.ts`.

`mcp_excalidraw/src/server.ts` is **not modified**.

## Section 1: Lane Routing Phase in `routeArrow`

### Location

`patches/layout.ts` → `routeArrow` function (currently ends at line ~231).

### Phase naming

The new addition inside `routeArrow` is called **"Phase 3 (lane routing)"**. This does not collide with the phase labels in `handleApplyLayout` — those are separate and unrelated; their labels are not changed.

### Return type extension

All four existing return statements in `routeArrow` (Phase 1 early return at line ~169, the unreachable guard at line ~218, the Phase 2 return at line ~226, and the new Phase 3 return) must include the new fields:

```ts
{
  points: Point[];
  elbowed: boolean;
  fromPt: Point;
  crossings: number;                         // NEW: obstacle crossings remaining
  routeType: 'straight' | 'elbow' | 'lane'; // NEW: which phase produced the result
  laneAxis?: 'x' | 'y';                     // NEW: present only when routeType === 'lane'
  laneCoord?: number;                        // NEW: the lane coordinate, present only when routeType === 'lane'
}
```

- Phase 1 return: `crossings: 0, routeType: 'straight'` (no `laneAxis`, no `laneCoord`)
- Phase 2 return: `crossings: best.count, routeType: 'elbow'`
- Unreachable guard: `crossings: 0, routeType: 'elbow'`
- Phase 3 return: `crossings: winner.count, routeType: 'lane', laneAxis: winner.axis, laneCoord: winner.coord`

In `handleCreateArrow`, emit `laneX = laneCoord` when `laneAxis === 'x'`, or `laneY = laneCoord` when `laneAxis === 'y'`.

### When Phase 3 runs

Phase 3 runs only when Phase 2's best elbow candidate has `crossings > 0`. If Phase 1 returns early, Phase 3 is skipped.

### Gap detection

All positions are in **Excalidraw canvas coordinate units** (same as element `x`, `y`, `width`, `height`). Zoom level does not affect these values.

**Vertical lanes** (candidates with `laneAxis: 'x'`):
1. Sort obstacles by left edge ascending: `obs.sort((a, b) => a.x - b.x)`.
2. For each adjacent pair `(obs[i], obs[i+1])`, compute `gap = obs[i+1].x − (obs[i].x + obs[i].width)`. If gap ≥ 20, add lane at `(obs[i].x + obs[i].width + obs[i+1].x) / 2`.
3. Always add two outer lanes: `Math.min(...obs.map(o => o.x)) − 40` and `Math.max(...obs.map(o => o.x + o.width)) + 40`.
4. Sort the resulting lane list ascending and deduplicate: if two consecutive lane values differ by < 5, drop the second one.

**Horizontal lanes** (candidates with `laneAxis: 'y'`):
Same logic on obstacles sorted by top edge: `obs.sort((a, b) => a.y - b.y)`. Gap = `obs[i+1].y − (obs[i].y + obs[i].height)`. Outer lanes: `min(y) − 40` and `max(y + height) + 40`. Same sort-and-dedup step.

### 3-segment path candidates

Phase 3 generates candidates for **both** vertical and horizontal lanes and selects the overall best across both sets. There is no pre-classification of "primarily vertical" vs. "primarily horizontal" — all lanes are scored and the minimum-crossing candidate wins regardless of axis.

For each vertical lane x-position `lx` and each of the 16 from/to side-midpoint pairs `(fp, tp)`:

```
candidate = [fp, (lx, fp[1]), (lx, tp[1]), tp]
```

For each horizontal lane y-position `ly` and each `(fp, tp)` pair:

```
candidate = [fp, (fp[0], ly), (tp[0], ly), tp]
```

**Degenerate filter:** before scoring, discard any candidate where two consecutive waypoints are identical (distance = 0). Apply this filter to both vertical and horizontal sets.

Score each remaining candidate with `countElbowIntersections(waypoints, obstacles)`. Track `axis` ('x' or 'y') and `coord` (the lane value) alongside each candidate. Select the candidate with the lowest crossing count across all valid candidates from both sets; break ties by shortest total path length.

If the winning Phase 3 candidate has fewer crossings than Phase 2's best count, return it. Otherwise, return Phase 2's result unchanged.

### `elbowed` flag

Set `elbowed: true` for all Phase 3 lane paths. This is required for the Excalidraw renderer to draw 4-point paths as right-angle segments.

### Call sites

`routeArrow` is called in four places in `patches/layout.ts`:

| Call site | Line (approx) | Reads new fields? |
|-----------|---------------|-------------------|
| `handleCreateArrow` | ~580 | **Yes** — reads `crossings`, `routeType`, `laneAxis`, `laneCoord` to populate `routing` response |
| `move_element` | ~763 | No — ignores new fields |
| `handleEdgesOnly` arrow loop | ~835 | **Yes** — collects per-edge `{ crossings, routeType }` for `routingSummary` |
| `handleApplyLayout` Phase 4 loop | ~1026 | **Yes** — same as above |

### Acceptance criteria

- **Regression**: all existing tests in `patches/layout.test.ts` pass unchanged.
- **Phase 3 unit tests** (new, in `patches/layout.test.ts`):
  - Vertical lane detection: given 3 column obstacles with 30px gaps (x-sorted), produces 2 interior lanes and 2 outer lanes (4 total); after dedup, still 4 distinct values.
  - Horizontal lane detection: same for y-sorted obstacles.
  - Degenerate candidate filtering: a candidate with two identical consecutive waypoints is excluded before scoring.
  - Cross-axis selection: given obstacles where a horizontal lane gives 0 crossings but the best vertical lane gives 1, the horizontal lane wins.
  - 3-segment scoring: a lane path that avoids all obstacles scores 0 crossings and is preferred over Phase 2's best at 2 crossings.
  - Phase 2 fallback: when no lane candidate reduces crossings below Phase 2's best, Phase 2's path and `routeType: 'elbow'` are returned.
  - Phase 1 return includes new fields: `crossings: 0, routeType: 'straight'`, no `laneAxis`.
- **Integration test** (new, in `patches/layout.test.ts`):
  - File path: construct using `path.join(new URL('.', import.meta.url).pathname, '../docs/example-diagram/example-diagram.excalidraw')` (one level up from `patches/` reaches the repo root, then into `docs/`).
  - Load with `JSON.parse(fs.readFileSync(filePath, 'utf8'))`. Extract elements array from `.elements`.
  - Construct `Box` for `init-b` and `svc-c` from their `{ x, y, width, height }` fields directly (both are fully-dimensioned rectangles).
  - Build the obstacle list: `elements.filter(e => e.id !== 'init-b' && e.id !== 'svc-c' && e.type !== 'arrow' && e.width && e.height)` (use truthy `width` and `height` — matches the filter used throughout the codebase; excludes text labels that have null/undefined dimensions).
  - Call `routeArrow(initBBox, svcCBox, obstacles)`.
  - Assert `crossings === 0` and `routeType === 'lane'`.

## Section 2: Route Quality Feedback

### `create_arrow` response

The existing response shape is `{ id, element }`. Add a `routing` field:

```json
{
  "id": "abc123",
  "element": { ... },
  "routing": {
    "type": "lane",
    "crossings": 0,
    "laneX": 465
  }
}
```

Complete field set per `type`:

| `type` | Fields always present | Fields conditionally present |
|--------|-----------------------|------------------------------|
| `straight` | `type`, `crossings` (= 0) | — |
| `elbow` | `type`, `crossings` | — |
| `lane` (vertical, `laneAxis: 'x'`) | `type`, `crossings` | `laneX` = `laneCoord` |
| `lane` (horizontal, `laneAxis: 'y'`) | `type`, `crossings` | `laneY` = `laneCoord` |

### `apply_layout` and `edges-only` responses

Both `handleApplyLayout` and `handleEdgesOnly` collect per-edge routing results and add `routingSummary` to their responses. Only edges with `crossings > 0` appear in the `edges` array:

```json
{
  "routingSummary": {
    "totalEdges": 10,
    "clean": 9,
    "withCrossings": 1,
    "edges": [
      { "fromId": "e6", "toId": "init-b", "crossings": 1, "type": "elbow" }
    ]
  }
}
```

`routingSummary` is always present (not conditional). `edges` is an empty array when all routes are clean. Both the normal layout response and the `edges-only` response include it.

## Section 3: Tool Descriptions + Diagram Guide

### `create_arrow` description update

In `patches/layout.ts`, locate the `create_arrow` tool `description` string. Append:

> Routes automatically in three tiers: **straight** if the path is clear, **elbow** (single bend) if one turn suffices, **lane** if the arrow must navigate around a cluster of elements by finding the gap between columns or rows. Check `routing.crossings` in the response — if > 0, the route still crosses elements and you should use `batch_create_elements` with explicit waypoints instead.

### `batch_create_elements` description update

In `mcp_excalidraw/src/index.ts`, locate the `batch_create_elements` tool `description` string. Add:

> **Cross-zone arrows with explicit waypoints:** when `create_arrow` returns `routing.crossings > 0`, pass an arrow element with explicit `points` (coordinates relative to the arrow's `x`, `y` origin) and omit `startElementId`/`endElementId`. Identify the gap lane x-position (midpoint between adjacent element columns), then use the 3-segment pattern: `points: [[0,0], [dx_to_lane, 0], [dx_to_lane, dy_to_target_row], [dx_to_target_side, dy_to_target_row]]`. Arrive at the **side** of the target element (not top/bottom) to avoid overlapping with arrows that enter from above or below.

### `read_diagram_guide` update

In `mcp_excalidraw/src/index.ts`, locate the `DIAGRAM_DESIGN_GUIDE` constant. Make two changes:

**1. Revise anti-pattern #4** — change from:

> Manual arrow coordinates — always use startElementId/endElementId binding.

To:

> Manual arrow coordinates — prefer `startElementId`/`endElementId` binding. Exception: when `create_arrow` returns `routing.crossings > 0`, use `batch_create_elements` with explicit `points` to route through a column gap (see "Cross-zone arrow routing" section below).

**2. Append a new section** at the end of `DIAGRAM_DESIGN_GUIDE`:

````markdown
## Cross-zone arrow routing

When an arrow must skip multiple zones (e.g., spanning 3 stacked rows of elements):

1. Call `create_arrow` first.
2. Check `routing.crossings` in the response.
3. If `crossings === 0`: done — the router found a clean path automatically.
4. If `crossings > 0`: fall back to `batch_create_elements` with explicit waypoints.

### Finding the column gap lane

Sort elements by x-position. The lane x is the midpoint of each gap ≥ 20px between adjacent right-edge and next left-edge. Also use `min(left_edges) − 40` or `max(right_edges) + 40` for outer bypass lanes.

Example — elements at x=[60–240], x=[270–450], x=[480–660]:
- Gap col 1→2: (240 + 270) / 2 = 255
- Gap col 2→3: (450 + 480) / 2 = 465
- Left outer lane: 60 − 40 = 20
- Right outer lane: 660 + 40 = 700

### 3-segment waypoint pattern (vertical lane)

Place the arrow at `x = source_cx, y = source_top`. Route:

```
(source_cx, source_top) → (lane_x, source_top) → (lane_x, target_mid_y) → (target_left_x, target_mid_y)
```

The arrowhead arrives at the **left side** of the target element.
This avoids overlap with arrows entering the target from the top or bottom.

### Which side to arrive on

- Cross-zone bypass arrows: arrive at **left or right side**
- Same-column adjacent-zone arrows: arrive at **top or bottom**
````

## Files Changed

| File | Change |
|------|--------|
| `patches/layout.ts` | Add Phase 3 inside `routeArrow`; extend all four return statements with new fields; update `handleCreateArrow` to populate `routing` field; update `handleEdgesOnly` and `handleApplyLayout` Phase 4 loop to collect and emit `routingSummary`; update `create_arrow` description string |
| `patches/layout.test.ts` | Add Phase 3 unit tests and integration test |
| `mcp_excalidraw/src/layout.ts` | Mirror of `patches/layout.ts` — updated in sync |
| `mcp_excalidraw/src/index.ts` | Update `batch_create_elements` description; revise anti-pattern #4 in `DIAGRAM_DESIGN_GUIDE`; append "Cross-zone arrow routing" section to `DIAGRAM_DESIGN_GUIDE` |

`mcp_excalidraw/src/server.ts` is **not modified**.

## Out of Scope

- A* / grid-based pathfinding (Phase 3 lane routing solves the observed failure cases)
- A dedicated `route_arrow` tool with explicit lane selection
- Semantic zone-awareness (lanes are derived purely from geometry)
- Changes to `move_element` routing (uses `routeArrow` but new fields not needed)
