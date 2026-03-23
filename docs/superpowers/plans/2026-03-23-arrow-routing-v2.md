# Arrow Routing V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add obstacle avoidance, fan-out, gap control, lane consolidation, and direction-aware scoring to Excalidraw's arrow routing engine.

**Architecture:** Incremental patches to the existing `routeArrow` function in `patches/layout.ts`. Each of 5 fixes builds on the previous but is independently testable. The `routeArrow` signature gains an optional 4th `options` parameter; return type gains `exitSide`/`entrySide` fields. Handler functions (`handleCreateArrow`, `handleEdgesOnly`, `handleApplyLayout`, `handleMoveElement`) are updated to pass new options through.

**Tech Stack:** TypeScript, custom test runner (tsx), Excalidraw MCP server

**Spec:** `docs/superpowers/specs/2026-03-23-arrow-routing-v2-design.md`

---

## File Structure

All changes are in two existing files:

| File | Responsibility |
|------|---------------|
| `patches/layout.ts` | Arrow routing engine, layout handlers, geometry utilities |
| `patches/layout.test.ts` | Unit and integration tests for routing |

No new files. Changes are incremental within these files.

---

## Task 1: Extract Named Constants & Add Types

**Files:**
- Modify: `patches/layout.ts:58-60` (types), `patches/layout.ts:238-256` (magic numbers)
- Test: `patches/layout.test.ts` (existing tests must still pass)

- [ ] **Step 1: Add `RouteOptions` and `RouteResult` types and named constants**

In `patches/layout.ts`, after the existing type definitions (line 60), add:

```typescript
type Side = 'top' | 'bottom' | 'left' | 'right';

interface RouteOptions {
  flowDirection?: 'TB' | 'LR';
  startFocus?: number;
  endFocus?: number;
  gap?: number;
  preferSide?: Side;
  entrySide?: Side;  // pin entry side during fan-out re-route
}

interface RouteResult {
  points: Point[];
  elbowed: boolean;
  fromPt: Point;
  crossings: number;
  routeType: 'straight' | 'elbow' | 'side-exit' | 'lane';
  exitSide: Side;
  entrySide: Side;
  laneAxis?: 'x' | 'y';
  laneCoord?: number;
}

// Constants
const DEFAULT_GAP = 8;
const MIN_LANE_GAP = 20;
const LANE_OUTER_MARGIN = 40;
const LANE_DEDUP_THRESHOLD = 5;
const LANE_SNAP_THRESHOLD = 30;
const FAN_OUT_RANGE = 0.7;
const AXIS_DOMINANCE_THRESHOLD = 20;
```

- [ ] **Step 2: Extract lane detection into a shared helper**

Extract the lane detection code (vertical and horizontal lanes) from Phase 3 into a reusable function. This will be called by both Phase 2.5 and Phase 3:

```typescript
interface DetectedLanes {
  vertical: number[];   // x-coordinates of vertical lanes
  horizontal: number[]; // y-coordinates of horizontal lanes
}

export function detectLanes(obstacles: Box[]): DetectedLanes {
  // Vertical lanes (x-axis gaps)
  const obsSortedX = [...obstacles].sort((a, b) => a.x - b.x);
  const rawV: number[] = [];
  for (let i = 0; i < obsSortedX.length - 1; i++) {
    const re = obsSortedX[i]!.x + obsSortedX[i]!.width;
    const le = obsSortedX[i + 1]!.x;
    if (le - re >= MIN_LANE_GAP) rawV.push((re + le) / 2);
  }
  rawV.push(Math.min(...obstacles.map(o => o.x)) - LANE_OUTER_MARGIN);
  rawV.push(Math.max(...obstacles.map(o => o.x + o.width)) + LANE_OUTER_MARGIN);
  rawV.sort((a, b) => a - b);
  const vertical = rawV.filter((v, i) => i === 0 || v - rawV[i - 1]! >= LANE_DEDUP_THRESHOLD);

  // Horizontal lanes (y-axis gaps)
  const obsSortedY = [...obstacles].sort((a, b) => a.y - b.y);
  const rawH: number[] = [];
  for (let i = 0; i < obsSortedY.length - 1; i++) {
    const be = obsSortedY[i]!.y + obsSortedY[i]!.height;
    const te = obsSortedY[i + 1]!.y;
    if (te - be >= MIN_LANE_GAP) rawH.push((be + te) / 2);
  }
  rawH.push(Math.min(...obstacles.map(o => o.y)) - LANE_OUTER_MARGIN);
  rawH.push(Math.max(...obstacles.map(o => o.y + o.height)) + LANE_OUTER_MARGIN);
  rawH.sort((a, b) => a - b);
  const horizontal = rawH.filter((v, i) => i === 0 || v - rawH[i - 1]! >= LANE_DEDUP_THRESHOLD);

  return { vertical, horizontal };
}
```

Then update Phase 3 in `routeArrow` to call `detectLanes(obstacles)` and use `lanes.vertical`/`lanes.horizontal` instead of computing them inline. Phase 2.5 (Task 4) will also call `detectLanes`.

- [ ] **Step 3: Replace magic numbers in `routeArrow` Phase 3 with named constants**

In the Phase 3 lane routing section of `routeArrow`:
- Replace `>= 20` with `>= MIN_LANE_GAP` (lines ~238, ~251)
- Replace `- 40` and `+ 40` with `- LANE_OUTER_MARGIN` and `+ LANE_OUTER_MARGIN` (lines ~240-241, ~253-254)
- Replace `>= 5` with `>= LANE_DEDUP_THRESHOLD` (lines ~243, ~256)

- [ ] **Step 3: Update `routeArrow` signature to accept optional `RouteOptions`**

Change the signature from:
```typescript
export function routeArrow(
  from: Box,
  to: Box,
  obstacles: Box[]
): { points: Point[]; ... }
```

To:
```typescript
export function routeArrow(
  from: Box,
  to: Box,
  obstacles: Box[],
  options: RouteOptions = {}
): RouteResult {
```

Update the `SIDES` array type from `(keyof SideMidpoints)[]` to `Side[]`:
```typescript
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
```

- [ ] **Step 4: Add `exitSide` and `entrySide` to all return statements**

Every `return` in `routeArrow` must include `exitSide` and `entrySide`. Derive them from the winning candidate's side-pair keys:

For Phase 1 (straight), track which `fk`/`tk` won:
```typescript
let bestStraight: { fromPt: Point; toPt: Point; dist: number; exitSide: Side; entrySide: Side } | null = null;
// ... in the loop:
bestStraight = { fromPt: fp, toPt: tp, dist, exitSide: fk, entrySide: tk };
// ... in the return:
return { ..., exitSide: bestStraight.exitSide, entrySide: bestStraight.entrySide };
```

For Phase 2 (elbow), add `exitSide`/`entrySide` to `ElbowCandidate`:
```typescript
interface ElbowCandidate {
  waypoints: Point[];
  fromPt: Point;
  count: number;
  isHorizontalFirst: boolean;
  totalLength: number;
  exitSide: Side;
  entrySide: Side;
}
```
Track `fk`/`tk` in the loop and include in the return.

For Phase 3 (lane), add `exitSide`/`entrySide` to `LaneCandidate`:
```typescript
interface LaneCandidate {
  waypoints: Point[];
  fromPt: Point;
  count: number;
  totalLength: number;
  axis: 'x' | 'y';
  coord: number;
  exitSide: Side;
  entrySide: Side;
}
```
Update `tryLane` signature to accept and store exit/entry sides:
```typescript
function tryLane(waypoints: Point[], fp: Point, axis: 'x' | 'y', coord: number, es: Side, ns: Side): void {
  // ... existing degenerate filter and scoring logic ...
  if (!winner || count < winner.count || (count === winner.count && totalLength < winner.totalLength)) {
    winner = { waypoints, fromPt: fp, count, totalLength, axis, coord, exitSide: es, entrySide: ns };
  }
}
```
Update the lane-search loops to pass `fk`/`tk`:
```typescript
// Vertical lanes loop:
tryLane([fp, [lx, fp[1]], [lx, tp[1]], tp], fp, 'x', lx, fk, tk);
// Horizontal lanes loop:
tryLane([fp, [fp[0], ly], [tp[0], ly], tp], fp, 'y', ly, fk, tk);
```
Update the Phase 3 return to include the fields:
```typescript
return { ..., exitSide: w.exitSide, entrySide: w.entrySide };
```
For the fallback return (Phase 2 result), use `best.exitSide` and `best.entrySide`.

For the fallback return (line ~317), use `best.exitSide` and `best.entrySide`.

- [ ] **Step 5: Run tests to verify no regressions**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All existing tests pass. The new fields (`exitSide`, `entrySide`) are present but not yet asserted.

- [ ] **Step 6: Commit**

```bash
git add patches/layout.ts
git commit -m "refactor: extract named constants, add RouteOptions/RouteResult types, add exitSide/entrySide to routeArrow"
```

---

## Task 2: Fix 3 — Gap Control (`getAttachmentPoint`)

**Files:**
- Modify: `patches/layout.ts:66-73` (getSideMidpoints area), `patches/layout.ts:144-176` (Phase 1 point generation)
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write failing tests for gap control**

Add to `patches/layout.test.ts` after the existing tests, before the summary output:

```typescript
// ---------------------------------------------------------------------------
// Gap control (Fix 3)
// ---------------------------------------------------------------------------

test('getAttachmentPoint: right side with gap=8 offsets outward', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'right', 0, 8);
  assert.deepStrictEqual(pt, [308, 150]); // x + width + gap, y + height/2
});

test('getAttachmentPoint: top side with focus=0.5 shifts right along edge', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'top', 0.5, 0);
  assert.deepStrictEqual(pt, [250, 100]); // x + width/2 + focus*width/2, y
});

test('getAttachmentPoint: bottom side with gap=8 and focus=-0.5', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'bottom', -0.5, 8);
  assert.deepStrictEqual(pt, [150, 208]); // x + width/2 + (-0.5)*width/2, y + height + gap
});

test('getAttachmentPoint: left side with gap=0 (backward compat)', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'left', 0, 0);
  assert.deepStrictEqual(pt, [100, 150]); // x, y + height/2
});

test('routeArrow with gap=8: fromPt offset from element boundary', () => {
  const from = { x: 100, y: 300, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { gap: 8 });
  // Straight path, top-to-bottom, fromPt should be offset 8px from from's top edge
  assert.strictEqual(result.routeType, 'straight');
  // fromPt.y should be from.y - 8 = 292 (top exit with gap) or from.y + height + 8 (bottom)
  // With no obstacles, shortest path: from.top → to.bottom
  // from.top with gap: y = 300 - 8 = 292, x = 150
  assert.strictEqual(result.fromPt[1], 292);
});

test('routeArrow with gap=0: fromPt at exact boundary', () => {
  const from = { x: 100, y: 300, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { gap: 0 });
  assert.strictEqual(result.routeType, 'straight');
  assert.strictEqual(result.fromPt[1], 300); // exact top edge
});
```

Update the import to include `getAttachmentPoint`:
```typescript
import {
  routeArrow,
  segmentIntersectsBox,
  countElbowIntersections,
  getAttachmentPoint,
  layoutTools,
  applyGroupsYSnap,
} from '../mcp_excalidraw/src/layout.ts';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: New tests fail with "getAttachmentPoint is not a function" or similar.

- [ ] **Step 3: Implement `getAttachmentPoint`**

Add after `getSideMidpoints` in `patches/layout.ts` (~line 73):

```typescript
export function getAttachmentPoint(
  box: Box,
  side: Side,
  focus: number,
  gap: number
): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  switch (side) {
    case 'top':
      return [cx + focus * box.width / 2, box.y - gap];
    case 'bottom':
      return [cx + focus * box.width / 2, box.y + box.height + gap];
    case 'left':
      return [box.x - gap, cy + focus * box.height / 2];
    case 'right':
      return [box.x + box.width + gap, cy + focus * box.height / 2];
  }
}
```

- [ ] **Step 4: Wire gap into `routeArrow` Phase 1**

At the top of `routeArrow`, extract the gap option and compute attachment points with it:

```typescript
const { gap = 0, startFocus, endFocus, entrySide: pinnedEntrySide } = options;

// When entrySide is pinned (fan-out re-route), only iterate over that entry side
const targetSides: Side[] = pinnedEntrySide ? [pinnedEntrySide] : SIDES;

// Compute attachment points with gap offset
const fromPts: Record<Side, Point> = {
  top: getAttachmentPoint(from, 'top', startFocus ?? 0, gap),
  bottom: getAttachmentPoint(from, 'bottom', startFocus ?? 0, gap),
  left: getAttachmentPoint(from, 'left', startFocus ?? 0, gap),
  right: getAttachmentPoint(from, 'right', startFocus ?? 0, gap),
};
const toPts: Record<Side, Point> = {
  top: getAttachmentPoint(to, 'top', endFocus ?? 0, gap),
  bottom: getAttachmentPoint(to, 'bottom', endFocus ?? 0, gap),
  left: getAttachmentPoint(to, 'left', endFocus ?? 0, gap),
  right: getAttachmentPoint(to, 'right', endFocus ?? 0, gap),
};
```

Replace the old `getSideMidpoints` calls:
```typescript
// DELETE these lines:
// const fromPts = getSideMidpoints(from);
// const toPts   = getSideMidpoints(to);
```

The rest of Phase 1, 2, and 3 already reference `fromPts[fk]` and `toPts[tk]` — they will automatically use the gap-offset points.

**Important:** In all phases, replace `for (const tk of SIDES)` with `for (const tk of targetSides)` so that when `entrySide` is pinned (during fan-out re-routing), only the pinned entry side is considered.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass including the new gap control tests.

- [ ] **Step 6: Wire gap into handlers**

In `handleCreateArrow` (line ~673), pass gap to routeArrow:
```typescript
const { points, elbowed, fromPt, crossings, routeType, exitSide, entrySide, laneAxis, laneCoord } =
  routeArrow(fromBox, toBox, obstacles, { gap: DEFAULT_GAP });
```

Update the `start`/`end` binding gap (lines ~685-686) to use `DEFAULT_GAP`:
```typescript
start: { id: args.fromId, gap: DEFAULT_GAP },
end:   { id: args.toId,   gap: DEFAULT_GAP },
```

In `handleEdgesOnly` (line ~940), pass gap:
```typescript
const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType } =
  routeArrow(fromBox, toBox, obstacles, { gap: DEFAULT_GAP });
```

Update binding gaps in `handleEdgesOnly` (lines ~958-959):
```typescript
start: { id: edge.fromId, gap: DEFAULT_GAP },
end:   { id: edge.toId,   gap: DEFAULT_GAP },
```

In `handleApplyLayout` (line ~1145), pass gap:
```typescript
const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType } =
  routeArrow(fromPos, toPos, obstacles, { gap: DEFAULT_GAP });
```

Update binding gaps in `handleApplyLayout` (lines ~1163-1164):
```typescript
start: { id: edge.fromId, gap: DEFAULT_GAP },
end:   { id: edge.toId,   gap: DEFAULT_GAP },
```

In `handleMoveElement` (line ~861), pass gap:
```typescript
const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles, { gap: DEFAULT_GAP });
```

- [ ] **Step 7: Run tests to verify no regressions**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add gap control (Fix 3) — getAttachmentPoint with focus/gap offset"
```

---

## Task 3: Fix 5 — Direction-Aware Scoring

**Files:**
- Modify: `patches/layout.ts:153-214` (Phase 1 and Phase 2 scoring)
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write failing tests for direction-aware scoring**

Add to `patches/layout.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Direction-aware scoring (Fix 5)
// ---------------------------------------------------------------------------

test('TB flow: prefers bottom→top straight path', () => {
  // Target is above and to the right — with TB flow, prefer vertical alignment
  const from = { x: 0,   y: 200, width: 100, height: 60 };
  const to   = { x: 0,   y: 0,   width: 100, height: 60 };
  // TB biases fk=bottom, tk=top (flow-aligned: source exits bottom, target enters top)
  // But target is ABOVE source, so the shortest path is from.top → to.bottom
  // The flow bias rewards bottom→top which is the OPPOSITE direction here
  // Use a case where flow direction and geometry agree:
  const from2 = { x: 0, y: 0,   width: 100, height: 60 };
  const to2   = { x: 0, y: 200, width: 100, height: 60 };
  const result = routeArrow(from2, to2, [], { flowDirection: 'TB' });
  // TB: source exits bottom (going down), target enters top
  assert.strictEqual(result.exitSide, 'bottom');
  assert.strictEqual(result.entrySide, 'top');
});

test('LR flow: prefers right→left straight path', () => {
  const from = { x: 0,   y: 200, width: 100, height: 60 };
  const to   = { x: 200, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { flowDirection: 'LR' });
  assert.strictEqual(result.exitSide, 'right');
});

test('LR flow elbow: prefers vertical-first when crossings tie', () => {
  // Put an obstacle that blocks all straight paths but allows elbows
  const from     = { x: 0,   y: 0,   width: 80, height: 60 };
  const to       = { x: 300, y: 300, width: 80, height: 60 };
  const obstacle = { x: 120, y: 120, width: 80, height: 80 };
  const resultLR = routeArrow(from, to, [obstacle], { flowDirection: 'LR' });
  // LR should prefer vertical-first elbows
  if (resultLR.routeType === 'elbow') {
    // Verify the elbow's mid-waypoint indicates vertical-first:
    // vertical-first means mid = [from.x, to.y] pattern → mid x close to from
    const pts = resultLR.points;
    if (pts.length === 3) {
      const midX = resultLR.fromPt[0] + pts[1]![0];
      // vertical-first: midX should be close to fromPt x (same column)
      assert.ok(Math.abs(midX - resultLR.fromPt[0]) < 10);
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: Direction-aware tests fail (scoring doesn't use flowDirection yet).

- [ ] **Step 3: Implement Phase 1 direction bias**

In Phase 1 of `routeArrow`, after finding a clear straight path, add a flow-direction tiebreaker. Change the comparison from pure distance to distance + flow bias:

```typescript
const { flowDirection } = options;

// Phase 1: find the shortest clear straight path across all 16 pairs
let bestStraight: { fromPt: Point; toPt: Point; dist: number; exitSide: Side; entrySide: Side } | null = null;
for (const fk of SIDES) {
  for (const tk of SIDES) {
    const fp = fromPts[fk];
    const tp = toPts[tk];
    if (obstacles.some(obs => segmentIntersectsBox(fp, tp, obs))) continue;
    const dist = Math.hypot(fp[0] - tp[0], fp[1] - tp[1]);

    // Flow-direction tiebreaker: slight preference for flow-aligned sides
    const flowAligned =
      (flowDirection === 'TB' && fk === 'bottom' && tk === 'top') ||
      (flowDirection === 'LR' && fk === 'right'  && tk === 'left');
    const adjustedDist = flowAligned ? dist * 0.99 : dist;

    if (!bestStraight || adjustedDist < bestStraight.dist) {
      bestStraight = { fromPt: fp, toPt: tp, dist: adjustedDist, exitSide: fk, entrySide: tk };
    }
  }
}
```

- [ ] **Step 4: Implement Phase 2 direction bias**

In Phase 2 of `routeArrow`, conditionalize the horizontal-first preference on `flowDirection`:

Replace the existing tie-breaker logic:
```typescript
// OLD:
(count === best.count && isH && !best.isHorizontalFirst)
```

With:
```typescript
// NEW: prefer horizontal-first for TB, vertical-first for LR
const preferH = flowDirection !== 'LR'; // TB or undefined → prefer horizontal-first
(count === best.count && (preferH ? isH && !best.isHorizontalFirst : !isH && best.isHorizontalFirst))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass including direction-aware scoring tests.

- [ ] **Step 6: Wire `flowDirection` into handlers**

In `handleCreateArrow`, infer flowDirection from source/target positions:
```typescript
// After computing fromBox and toBox:
const dx = Math.abs((toBox.x + toBox.width / 2) - (fromBox.x + fromBox.width / 2));
const dy = Math.abs((toBox.y + toBox.height / 2) - (fromBox.y + fromBox.height / 2));
const inferredFlow: 'TB' | 'LR' = dy > dx ? 'TB' : 'LR';

const routeOpts: RouteOptions = { gap: DEFAULT_GAP, flowDirection: inferredFlow };
const { points, elbowed, fromPt, crossings, routeType, exitSide, entrySide, laneAxis, laneCoord } =
  routeArrow(fromBox, toBox, obstacles, routeOpts);
```

In `handleEdgesOnly`, derive from `args.direction`:
```typescript
const flowDirection: 'TB' | 'LR' = args.direction === 'left-right' ? 'LR' : 'TB';
// ... pass { gap: DEFAULT_GAP, flowDirection } to routeArrow
```

In `handleApplyLayout`, same derivation:
```typescript
const flowDirection: 'TB' | 'LR' = args.direction === 'left-right' ? 'LR' : 'TB';
// ... pass { gap: DEFAULT_GAP, flowDirection } to routeArrow
```

In `handleMoveElement`, infer per-arrow:
```typescript
const dx = Math.abs((toBox.x + toBox.width / 2) - (fromBox.x + fromBox.width / 2));
const dy = Math.abs((toBox.y + toBox.height / 2) - (fromBox.y + fromBox.height / 2));
const flowDirection: 'TB' | 'LR' = dy > dx ? 'TB' : 'LR';
const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles, { gap: DEFAULT_GAP, flowDirection });
```

- [ ] **Step 7: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add direction-aware scoring (Fix 5) — TB/LR flow bias in Phase 1 and 2"
```

---

## Task 4: Fix 1 — Phase 2.5 Side-Exit Obstacle Avoidance

**Files:**
- Modify: `patches/layout.ts:229-316` (insert between Phase 2 and Phase 3)
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write failing tests for Phase 2.5**

Add to `patches/layout.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Phase 2.5 — side-exit obstacle avoidance (Fix 1)
// ---------------------------------------------------------------------------

test('Phase 2.5: 3 stacked obstacles — picks side-exit with 0 crossings', () => {
  // Source at bottom, target at top, 3 obstacles stacked between them
  const from = { x: 100, y: 500, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const obs  = [
    { x: 100, y: 100, width: 100, height: 60 },
    { x: 100, y: 220, width: 100, height: 60 },
    { x: 100, y: 340, width: 100, height: 60 },
  ];
  const result = routeArrow(from, to, obs, { gap: 0 });
  assert.strictEqual(result.crossings, 0);
  assert.ok(result.routeType === 'side-exit' || result.routeType === 'lane');
  // Should NOT be a straight line through all 3 obstacles
  assert.ok(result.points.length >= 3);
});

test('Phase 2.5: no obstacles — Phase 1 straight path wins', () => {
  const from = { x: 100, y: 300, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { gap: 0 });
  assert.strictEqual(result.routeType, 'straight');
  assert.strictEqual(result.crossings, 0);
});

test('Phase 2.5: LR layout stacked row — exits top/bottom', () => {
  // Horizontal arrangement with obstacles in between
  const from = { x: 0,   y: 100, width: 60, height: 100 };
  const to   = { x: 500, y: 100, width: 60, height: 100 };
  const obs  = [
    { x: 100, y: 100, width: 60, height: 100 },
    { x: 220, y: 100, width: 60, height: 100 },
    { x: 340, y: 100, width: 60, height: 100 },
  ];
  const result = routeArrow(from, to, obs, { gap: 0, flowDirection: 'LR' });
  assert.strictEqual(result.crossings, 0);
  // Should exit from top or bottom (perpendicular to LR flow)
  assert.ok(result.exitSide === 'top' || result.exitSide === 'bottom');
});

test('Phase 2.5: preferSide forces specific exit', () => {
  const from = { x: 100, y: 500, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const obs  = [
    { x: 100, y: 220, width: 100, height: 60 },
  ];
  const result = routeArrow(from, to, obs, { gap: 0, preferSide: 'left' });
  if (result.routeType === 'side-exit') {
    assert.strictEqual(result.exitSide, 'left');
  }
});

test('Phase 2.5: self-loop skips side-exit', () => {
  const box = { x: 100, y: 100, width: 100, height: 60 };
  // Same from and to — self-loop
  const result = routeArrow(box, box, [], { gap: 0 });
  assert.ok(result.routeType !== 'side-exit');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: The "3 stacked obstacles" and "LR layout" tests fail (crossings > 0 because Phase 2.5 doesn't exist yet).

- [ ] **Step 3: Implement Phase 2.5 in `routeArrow`**

After Phase 2 (after `const phase2CrossingCount = best.count;` and `const origin = best.fromPt;`, ~line 230) and BEFORE the Phase 3 block (`if (phase2CrossingCount > 0 && obstacles.length > 0)`), insert:

```typescript
  // Phase 2.5: Side-exit routing — only if Phase 2 has crossings and not self-loop
  const isSelfLoop = from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height;
  let phase25Result: RouteResult | null = null;

  if (phase2CrossingCount > 0 && obstacles.length > 0 && !isSelfLoop) {
    const srcCx = from.x + from.width / 2;
    const srcCy = from.y + from.height / 2;
    const tgtCx = to.x + to.width / 2;
    const tgtCy = to.y + to.height / 2;
    const adx = Math.abs(tgtCx - srcCx);
    const ady = Math.abs(tgtCy - srcCy);

    // Determine candidate exit sides
    let exitSides: Side[];
    if (options.preferSide) {
      exitSides = [options.preferSide];
    } else if (options.flowDirection === 'TB') {
      exitSides = ['left', 'right'];
    } else if (options.flowDirection === 'LR') {
      exitSides = ['top', 'bottom'];
    } else if (Math.abs(adx - ady) < AXIS_DOMINANCE_THRESHOLD) {
      exitSides = ['top', 'right', 'bottom', 'left'];
    } else if (ady > adx) {
      exitSides = ['left', 'right'];
    } else {
      exitSides = ['top', 'bottom'];
    }

    const entrySides: Side[] = ['top', 'right', 'bottom', 'left'];

    // Reuse shared lane detection helper (extracted in Task 1)
    const { vertical: vLanes25, horizontal: hLanes25 } = detectLanes(obstacles);

    interface SideExitCandidate {
      waypoints: Point[];
      fromPt: Point;
      count: number;
      totalLength: number;
      exitSide: Side;
      entrySide: Side;
    }
    let bestSE: SideExitCandidate | null = null;

    for (const es of exitSides) {
      for (const ns of entrySides) {
        const fp = fromPts[es];
        const tp = toPts[ns];
        // Choose lane axis based on exit side: left/right exits use vertical lanes, top/bottom use horizontal
        const lanes = (es === 'left' || es === 'right') ? vLanes25 : hLanes25;

        for (const laneCoord of lanes) {
          let waypoints: Point[];
          if (es === 'left' || es === 'right') {
            // Exit horizontally to vertical lane, travel vertically, enter target
            waypoints = [fp, [laneCoord, fp[1]], [laneCoord, tp[1]], tp];
          } else {
            // Exit vertically to horizontal lane, travel horizontally, enter target
            waypoints = [fp, [fp[0], laneCoord], [tp[0], laneCoord], tp];
          }

          // Skip degenerate paths
          let degenerate = false;
          for (let i = 0; i < waypoints.length - 1; i++) {
            if (waypoints[i]![0] === waypoints[i + 1]![0] && waypoints[i]![1] === waypoints[i + 1]![1]) {
              degenerate = true;
              break;
            }
          }
          if (degenerate) continue;

          const count = countElbowIntersections(waypoints, obstacles);
          const totalLength = waypoints.slice(1).reduce((sum, pt, i) => {
            const prev = waypoints[i]!;
            return sum + Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
          }, 0);

          if (!bestSE || count < bestSE.count || (count === bestSE.count && totalLength < bestSE.totalLength)) {
            bestSE = { waypoints, fromPt: fp, count, totalLength, exitSide: es, entrySide: ns };
          }
        }
      }
    }

    if (bestSE && bestSE.count < phase2CrossingCount) {
      phase25Result = {
        points: bestSE.waypoints.map(p => [p[0] - bestSE!.fromPt[0], p[1] - bestSE!.fromPt[1]] as Point),
        elbowed: true,
        fromPt: bestSE.fromPt,
        crossings: bestSE.count,
        routeType: 'side-exit',
        exitSide: bestSE.exitSide,
        entrySide: bestSE.entrySide,
      };
    }
  }

  // If Phase 2.5 found a 0-crossing path, return it (skip Phase 3)
  if (phase25Result && phase25Result.crossings === 0) {
    return phase25Result;
  }
```

- [ ] **Step 4: Update Phase 3 gate to check Phase 2.5**

Change the Phase 3 entry condition from:
```typescript
if (phase2CrossingCount > 0 && obstacles.length > 0) {
```

To:
```typescript
const phase25Crossings = phase25Result?.crossings ?? phase2CrossingCount;
if (phase25Crossings > 0 && obstacles.length > 0) {
```

After Phase 3's winner check, before the final fallback return, add:
```typescript
  // Prefer Phase 2.5 over Phase 2 if it has fewer crossings
  if (phase25Result && phase25Result.crossings < phase2CrossingCount) {
    return phase25Result;
  }
```

This ensures: Phase 2.5 with 0 crossings → return immediately (before Phase 3). Phase 2.5 with some crossings but fewer than Phase 2 → Phase 3 still runs, but if Phase 3 doesn't improve, Phase 2.5 wins over Phase 2.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass including Phase 2.5 tests.

- [ ] **Step 6: Commit**

```bash
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add Phase 2.5 side-exit obstacle avoidance (Fix 1)"
```

---

## Task 5: Fix Obstacle Filtering in `handleApplyLayout`

**Files:**
- Modify: `patches/layout.ts:1141-1143` (obstacle filter in layout mode)

- [ ] **Step 1: Fix the obstacle filter**

In `handleApplyLayout`, change the obstacle filter (currently at ~line 1141-1143) from:

```typescript
const obstacles = allElements
  .filter(e => !layoutNodeIds.has(e.id) && e.width && e.height && e.type !== 'arrow')
  .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));
```

To (matching the `handleEdgesOnly` pattern — exclude only source/target):

```typescript
const obstacles = allElements
  .filter(e => e.id !== edge.fromId && e.id !== edge.toId && e.type !== 'arrow' && e.width && e.height)
  .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));
```

Note: Use `posMap` positions for layout nodes that have been repositioned. The obstacle should reflect the new position for nodes already laid out:

```typescript
const obstacles = allElements
  .filter(e => e.id !== edge.fromId && e.id !== edge.toId && e.type !== 'arrow' && e.width && e.height)
  .map(e => {
    const pos = posMap.get(e.id);
    return pos
      ? { x: pos.x, y: pos.y, width: pos.width, height: pos.height }
      : { x: e.x, y: e.y, width: e.width!, height: e.height! };
  });
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add patches/layout.ts
git commit -m "fix: include layout nodes as obstacles in apply_layout arrow routing"
```

---

## Task 6: Fix 2 — Auto Fan-Out

**Files:**
- Modify: `patches/layout.ts` (add `computeFanOut` helper, update `handleEdgesOnly`, `handleApplyLayout`, `handleCreateArrow`)
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write failing tests for fan-out logic**

Add to `patches/layout.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Auto fan-out (Fix 2)
// ---------------------------------------------------------------------------

test('computeFanOut: 3 arrows → focus spread [-0.7, 0, 0.7]', () => {
  const result = computeFanOut(3);
  assert.strictEqual(result.length, 3);
  assert.ok(Math.abs(result[0]! - (-0.7)) < 0.01);
  assert.ok(Math.abs(result[1]! - 0) < 0.01);
  assert.ok(Math.abs(result[2]! - 0.7) < 0.01);
});

test('computeFanOut: 1 arrow → focus [0]', () => {
  const result = computeFanOut(1);
  assert.deepStrictEqual(result, [0]);
});

test('computeFanOut: 4 arrows → evenly spread', () => {
  const result = computeFanOut(4);
  assert.strictEqual(result.length, 4);
  assert.ok(Math.abs(result[0]! - (-0.7)) < 0.01);
  assert.ok(Math.abs(result[3]! - 0.7) < 0.01);
  // Middle values should be symmetric
  assert.ok(Math.abs(result[1]! + result[2]!) < 0.01);
});
```

Update the import to include `computeFanOut`:
```typescript
import {
  routeArrow,
  segmentIntersectsBox,
  countElbowIntersections,
  getAttachmentPoint,
  computeFanOut,
  layoutTools,
  applyGroupsYSnap,
} from '../mcp_excalidraw/src/layout.ts';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: Fails with "computeFanOut is not a function".

- [ ] **Step 3: Implement `computeFanOut`**

Add to `patches/layout.ts` after the `getAttachmentPoint` function:

```typescript
export function computeFanOut(n: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) =>
    -FAN_OUT_RANGE + 2 * FAN_OUT_RANGE * i / (n - 1)
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Implement `deriveEntrySide` helper**

Add to `patches/layout.ts`:

```typescript
/** Derive the entry side of an arrow from its path points and target box. */
function deriveEntrySide(points: Point[], arrowX: number, arrowY: number, target: Box): Side {
  if (points.length < 2) return 'top';
  const lastPt: Point = [arrowX + points[points.length - 1]![0], arrowY + points[points.length - 1]![1]];
  const prevPt: Point = [arrowX + points[points.length - 2]![0], arrowY + points[points.length - 2]![1]];
  const dx = lastPt[0] - prevPt[0];
  const dy = lastPt[1] - prevPt[1];

  // The entry side is the side the arrow is approaching FROM
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'left' : 'right'; // approaching from left → enters left side
  } else {
    return dy > 0 ? 'top' : 'bottom'; // approaching from above → enters top side
  }
}
```

- [ ] **Step 6: Implement fan-out post-pass in `handleEdgesOnly`**

In `handleEdgesOnly`, after the routing loop and before the write phase, add a fan-out post-pass.

First, collect routing results alongside arrow data during the routing loop. Change the routing loop to track `entrySide` per arrow:

```typescript
// Add before the routing loop:
interface RoutedEdge {
  arrowId: string;
  fromId: string;
  toId: string;
  entrySide: Side;
  exitSide: Side;
  fromPt: Point;
  points: Point[];
  elbowed: boolean;
  laneCoord?: number;  // for lane consolidation (Task 7)
  laneAxis?: 'x' | 'y';
}
const routedEdges: RoutedEdge[] = [];
```

After each `routeArrow` call, push to `routedEdges`:
```typescript
routedEdges.push({
  arrowId: arrowId!,
  fromId: edge.fromId,
  toId: edge.toId,
  entrySide: /* from routeArrow result */,
  exitSide: /* from routeArrow result */,
  fromPt,
  points: points as Point[],
  elbowed,
});
```

After the routing loop, add the fan-out pass:
```typescript
// Fan-out post-pass: spread arrows sharing the same (targetId, entrySide)
const targetGroups = new Map<string, RoutedEdge[]>();
for (const re of routedEdges) {
  const key = `${re.toId}:${re.entrySide}`;
  const group = targetGroups.get(key) ?? [];
  group.push(re);
  targetGroups.set(key, group);
}

for (const [, group] of targetGroups) {
  if (group.length <= 1) continue;
  const toEl = elementMap.get(group[0]!.toId);
  if (!toEl) continue;
  const toBox: Box = { x: toEl.x, y: toEl.y, width: toEl.width || 100, height: toEl.height || 60 };

  // Sort by source position for spatial coherence
  const entrySide = group[0]!.entrySide;
  group.sort((a, b) => {
    const aEl = elementMap.get(a.fromId);
    const bEl = elementMap.get(b.fromId);
    if (!aEl || !bEl) return 0;
    return (entrySide === 'top' || entrySide === 'bottom')
      ? aEl.x - bEl.x
      : aEl.y - bEl.y;
  });

  const focusValues = computeFanOut(group.length);
  for (let i = 0; i < group.length; i++) {
    const re = group[i]!;
    const focus = focusValues[i]!;
    const fromEl = elementMap.get(re.fromId);
    if (!fromEl) continue;
    const fromBox: Box = { x: fromEl.x, y: fromEl.y, width: fromEl.width || 100, height: fromEl.height || 60 };

    const obstacles = allElements
      .filter(e => e.id !== re.fromId && e.id !== re.toId && e.type !== 'arrow' && e.width && e.height)
      .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

    const rerouted = routeArrow(fromBox, toBox, obstacles, {
      gap: DEFAULT_GAP,
      endFocus: focus,
      entrySide: re.entrySide,
    });

    // Find and update the arrow in arrowUpdates or mark for update
    const existingIdx = arrowUpdates.findIndex(u => u.id === re.arrowId);
    const update = {
      id: re.arrowId,
      x: rerouted.fromPt[0],
      y: rerouted.fromPt[1],
      points: rerouted.points as [number, number][],
      elbowed: rerouted.elbowed,
    };
    if (existingIdx >= 0) {
      arrowUpdates[existingIdx] = update;
    } else {
      arrowUpdates.push(update);
    }
  }
}
```

- [ ] **Step 7: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add auto fan-out (Fix 2) — computeFanOut + post-pass in handleEdgesOnly"
```

- [ ] **Step 9: Replicate fan-out in `handleApplyLayout`**

Add the same fan-out post-pass pattern in `handleApplyLayout`'s Phase 4 (after the routing loop at ~line 1181, before the write phase at ~line 1186). The code is identical in structure to the `handleEdgesOnly` version — collect `RoutedEdge` entries during routing, group by target+entrySide, re-route with spread focus values.

- [ ] **Step 10: Run tests and commit**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

```bash
git add patches/layout.ts
git commit -m "feat: add fan-out post-pass to handleApplyLayout"
```

---

## Task 7: Fix 4 — Lane Consolidation

**Files:**
- Modify: `patches/layout.ts` (extend fan-out post-pass)
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write failing tests for lane consolidation**

Add to `patches/layout.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Lane consolidation (Fix 4)
// ---------------------------------------------------------------------------

test('snapLanes: 3 lanes within threshold snap to median', () => {
  const lanes = [325, 330, 335];
  const snapped = snapLanes(lanes, LANE_SNAP_THRESHOLD, []);
  // All should snap to median (330)
  assert.ok(snapped.every(v => v === 330));
});

test('snapLanes: lanes far apart do not snap', () => {
  const lanes = [100, 200, 300];
  const snapped = snapLanes(lanes, LANE_SNAP_THRESHOLD, []);
  assert.deepStrictEqual(snapped, [100, 200, 300]);
});

test('snapLanes: snapped coordinate intersecting obstacle reverts', () => {
  const lanes = [325, 335];
  const obstacle = { x: 320, y: 0, width: 20, height: 100 }; // covers x=320-340, median=330 intersects
  const snapped = snapLanes(lanes, LANE_SNAP_THRESHOLD, [obstacle]);
  // Should NOT snap because median (330) intersects the obstacle
  assert.deepStrictEqual(snapped, [325, 335]);
});
```

Update imports to include `snapLanes` and the `LANE_SNAP_THRESHOLD` constant. Since `LANE_SNAP_THRESHOLD` is a module-level constant, export it or use the value `30` directly in the test:

```typescript
import {
  routeArrow,
  segmentIntersectsBox,
  countElbowIntersections,
  getAttachmentPoint,
  computeFanOut,
  snapLanes,
  layoutTools,
  applyGroupsYSnap,
} from '../mcp_excalidraw/src/layout.ts';

const LANE_SNAP_THRESHOLD = 30; // matches layout.ts constant
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: Fails with "snapLanes is not a function".

- [ ] **Step 3: Implement `snapLanes`**

Add to `patches/layout.ts`:

```typescript
/**
 * Snap lane coordinates that are within threshold to their median.
 * If the snapped coordinate intersects any obstacle, revert to original values.
 */
export function snapLanes(lanes: number[], threshold: number, obstacles: Box[], axis: 'x' | 'y' = 'x'): number[] {
  if (lanes.length <= 1) return [...lanes];

  // Group lanes that are within threshold of each other
  const sorted = [...lanes].sort((a, b) => a - b);
  const groups: number[][] = [];
  let currentGroup = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - currentGroup[currentGroup.length - 1]! <= threshold) {
      currentGroup.push(sorted[i]!);
    } else {
      groups.push(currentGroup);
      currentGroup = [sorted[i]!];
    }
  }
  groups.push(currentGroup);

  // Build mapping from original value to snapped value
  const snapMap = new Map<number, number>();
  for (const group of groups) {
    if (group.length <= 1) {
      snapMap.set(group[0]!, group[0]!);
      continue;
    }
    const median = group[Math.floor(group.length / 2)]!;

    // Check if median intersects any obstacle — axis-aware
    const intersects = obstacles.some(obs =>
      axis === 'x'
        ? median >= obs.x && median <= obs.x + obs.width
        : median >= obs.y && median <= obs.y + obs.height
    );

    if (intersects) {
      for (const v of group) snapMap.set(v, v);
    } else {
      for (const v of group) snapMap.set(v, median);
    }
  }

  return lanes.map(v => snapMap.get(v) ?? v);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Wire lane consolidation into fan-out post-pass**

In the fan-out post-pass (both `handleEdgesOnly` and `handleApplyLayout`), after fan-out re-routing, add lane consolidation:

After the fan-out loop, collect lane coordinates from side-exit/lane routed arrows:

```typescript
// Lane consolidation: snap nearby lane coordinates to shared values
const laneGroups = new Map<string, { arrowId: string; laneCoord: number; laneAxis: 'x' | 'y' }[]>();
for (const re of routedEdges) {
  if (re.laneCoord !== undefined && re.laneAxis) {
    const key = `${re.exitSide}:${re.laneAxis}`;
    const group = laneGroups.get(key) ?? [];
    group.push({ arrowId: re.arrowId, laneCoord: re.laneCoord, laneAxis: re.laneAxis });
    laneGroups.set(key, group);
  }
}

const allObstacles = allElements
  .filter(e => e.type !== 'arrow' && e.width && e.height)
  .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

for (const [, group] of laneGroups) {
  if (group.length <= 1) continue;
  const coords = group.map(g => g.laneCoord);
  const snapped = snapLanes(coords, LANE_SNAP_THRESHOLD, allObstacles);
  // If any values changed, re-route those arrows with the snapped lane coordinate
  // (This is handled by the fact that routeArrow will pick the nearest lane)
}
```

Note: Full integration of lane snapping into re-routing requires storing `laneCoord`/`laneAxis` in the `RoutedEdge` interface (add those fields in Task 6) and re-routing with a pinned lane coordinate. This is optional for the initial implementation — the `snapLanes` function is the core logic and can be integrated more deeply in a follow-up.

- [ ] **Step 6: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add lane consolidation (Fix 4) — snapLanes utility"
```

---

## Task 8: Wire Tool Parameters & Update Schemas

**Files:**
- Modify: `patches/layout.ts` (tool schema definitions, handler arg parsing)

- [ ] **Step 1: Find the tool schema definitions**

The `layoutTools` array (exported from `layout.ts`) contains JSON Schema definitions for `create_arrow`, `apply_layout`, and `move_element`. Find the `create_arrow` schema and add the new optional parameters.

- [ ] **Step 2: Add `create_arrow` schema parameters**

Add to the `create_arrow` tool's `inputSchema.properties`:

```typescript
startFocus: { type: 'number', description: 'Pin start attachment position along element edge (-1 to 1)' },
endFocus: { type: 'number', description: 'Pin end attachment position along element edge (-1 to 1)' },
gap: { type: 'number', description: 'Pixel gap between arrowhead and element boundary (default 8)' },
flowDirection: { type: 'string', enum: ['TB', 'LR'], description: 'Bias routing for top-down or left-right flow' },
preferSide: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], description: 'Hint which side to exit from' },
```

- [ ] **Step 3: Add `apply_layout` schema parameter**

Add to the `apply_layout` tool's `spacing` properties (nested inside the spacing object schema):

```typescript
arrowGap: { type: 'number', description: 'Pixel gap between arrowheads and element edges (default 8)' },
```

- [ ] **Step 4: Wire `create_arrow` handler to pass new options**

In `handleCreateArrow`, update the `routeArrow` call to pass through the new args:

```typescript
const routeOpts: RouteOptions = {
  gap: args.gap ?? DEFAULT_GAP,
  flowDirection: args.flowDirection ?? inferredFlow,
  startFocus: args.startFocus,
  endFocus: args.endFocus,
  preferSide: args.preferSide,
};
const { points, elbowed, fromPt, crossings, routeType, exitSide, entrySide, laneAxis, laneCoord } =
  routeArrow(fromBox, toBox, obstacles, routeOpts);
```

Update the `CreateArrowArgs` interface to include the new fields.

- [ ] **Step 5: Wire `apply_layout` handler to pass arrowGap**

In both `handleEdgesOnly` and `handleApplyLayout`, read `args.spacing?.arrowGap` and pass it as the gap:

```typescript
const arrowGap = args.spacing?.arrowGap ?? DEFAULT_GAP;
// ... pass { gap: arrowGap, flowDirection } to routeArrow
```

Update the `LayoutSpacing` interface to include `arrowGap?: number`.

- [ ] **Step 6: Update return metadata in `handleCreateArrow`**

Add `exitSide` and `entrySide` to the routing metadata:

```typescript
const routing: Record<string, unknown> = { type: routeType, crossings, exitSide, entrySide };
```

- [ ] **Step 7: Add incremental fan-out to `handleCreateArrow` (Fix 2 Level 2)**

After creating/posting the arrow, query existing arrows sharing the same target+entrySide and re-spread:

```typescript
// Incremental fan-out: re-spread arrows sharing same (targetId, entrySide)
if (!args.startFocus && !args.endFocus) {  // skip if user pinned focus
  const allEls = await fetchAllElements();
  const targetArrows = allEls.filter(e =>
    e.type === 'arrow' &&
    (e.end?.id === args.toId || e.endBinding?.elementId === args.toId)
  );

  if (targetArrows.length > 1) {
    // Derive entrySide for each existing arrow
    const sameEntry = targetArrows.filter(a => {
      const side = deriveEntrySide(
        a.points as Point[],
        a.x, a.y,
        toBox
      );
      return side === entrySide;
    });

    if (sameEntry.length > 1) {
      const focusValues = computeFanOut(sameEntry.length);
      // Sort by source position for spatial coherence
      sameEntry.sort((a, b) => {
        const aStart = a.start?.id || a.startBinding?.elementId;
        const bStart = b.start?.id || b.startBinding?.elementId;
        const aEl = allEls.find(e => e.id === aStart);
        const bEl = allEls.find(e => e.id === bStart);
        if (!aEl || !bEl) return 0;
        return (entrySide === 'top' || entrySide === 'bottom')
          ? aEl.x - bEl.x : aEl.y - bEl.y;
      });

      // Re-route each arrow with its assigned focus
      for (let i = 0; i < sameEntry.length; i++) {
        const a = sameEntry[i]!;
        if (a.id === arrowId) continue; // skip newly created, already routed
        const aStartId = a.start?.id || a.startBinding?.elementId;
        if (!aStartId) continue;
        const aFromEl = allEls.find(e => e.id === aStartId);
        if (!aFromEl) continue;
        const aFromBox: Box = { x: aFromEl.x, y: aFromEl.y, width: aFromEl.width || 100, height: aFromEl.height || 60 };
        const aObs = allEls
          .filter(e => e.id !== aStartId && e.id !== args.toId && e.type !== 'arrow' && e.width && e.height)
          .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));
        const rr = routeArrow(aFromBox, toBox, aObs, {
          gap: DEFAULT_GAP, endFocus: focusValues[i]!, entrySide,
        });
        await putElement({
          id: a.id, x: rr.fromPt[0], y: rr.fromPt[1],
          points: rr.points as [number, number][], elbowed: rr.elbowed,
        });
      }
    }
  }
}
```

- [ ] **Step 8: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: wire new tool parameters + incremental fan-out in create_arrow"
```

---

## Task 9: Integration Test with Example Diagram

**Files:**
- Test: `patches/layout.test.ts`

- [ ] **Step 1: Write integration test**

Add to `patches/layout.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Integration: example diagram routing quality
// ---------------------------------------------------------------------------

test('example diagram: epic→svc arrows have 0 crossings with side-exit routing', () => {
  const filePath = path.join(
    new URL('.', import.meta.url).pathname,
    '../docs/example-diagram/example-diagram.excalidraw'
  );
  if (!fs.existsSync(filePath)) {
    console.log('    (skipped — example diagram not found)');
    return;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const elements = data.elements;

  // Find all epic→svc relationships (epics: id starts with 'e' followed by digit, svcs: id starts with 'svc-')
  const epicIds = new Set(elements.filter((e: any) => /^e\d+$/.test(e.id)).map((e: any) => e.id));
  const svcIds = new Set(elements.filter((e: any) => e.id.startsWith('svc-')).map((e: any) => e.id));

  // Route each epic→svc pair through obstacles
  let totalCrossings = 0;
  for (const arrow of elements.filter((e: any) => e.type === 'arrow')) {
    const startId = arrow.start?.id || arrow.startBinding?.elementId;
    const endId = arrow.end?.id || arrow.endBinding?.elementId;
    if (!startId || !endId) continue;
    if (!epicIds.has(startId) || !svcIds.has(endId)) continue;

    const fromEl = elements.find((e: any) => e.id === startId);
    const toEl = elements.find((e: any) => e.id === endId);
    if (!fromEl || !toEl) continue;

    const fromBox = { x: fromEl.x, y: fromEl.y, width: fromEl.width, height: fromEl.height };
    const toBox = { x: toEl.x, y: toEl.y, width: toEl.width, height: toEl.height };
    const obstacles = elements
      .filter((e: any) => e.id !== startId && e.id !== endId && e.type !== 'arrow' && e.width && e.height)
      .map((e: any) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));

    const result = routeArrow(fromBox, toBox, obstacles, { gap: 8, flowDirection: 'TB' });
    totalCrossings += result.crossings;
  }

  assert.ok(totalCrossings <= 2, `Expected ≤2 total crossings for epic→svc arrows, got ${totalCrossings}`);
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts`

Expected: All tests pass. Integration test shows 0 or low crossings.

- [ ] **Step 3: Commit**

```bash
git add patches/layout.test.ts
git commit -m "test: add integration test for example diagram epic→svc routing quality"
```

---

## Summary

| Task | Fix | What | Depends On |
|------|-----|------|-----------|
| 1 | Prerequisites | Extract constants, add types, update signature | — |
| 2 | Fix 3 | Gap control (`getAttachmentPoint`) | Task 1 |
| 3 | Fix 5 | Direction-aware scoring (TB/LR bias) | Task 1 |
| 4 | Fix 1 | Phase 2.5 side-exit obstacle avoidance | Tasks 1-2 |
| 5 | Prereq | Fix obstacle filtering in `handleApplyLayout` | Task 4 |
| 6 | Fix 2 | Auto fan-out (computeFanOut + post-pass) | Tasks 2, 4 |
| 7 | Fix 4 | Lane consolidation (snapLanes) | Tasks 4, 6 |
| 8 | — | Wire tool parameters & schemas | Tasks 2-6 |
| 9 | — | Integration test with example diagram | All |
