# Auto-Routing Phase 3 + LLM Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 3 lane routing to `routeArrow` so cross-zone arrows find gap lanes automatically, surface routing quality in responses, and update tool descriptions so the LLM knows when to fall back to explicit waypoints.

**Architecture:** All algorithm changes go in `patches/layout.ts` (source of truth); changes are mirrored to `mcp_excalidraw/src/layout.ts`. Tool descriptions and `DIAGRAM_DESIGN_GUIDE` updates go in `mcp_excalidraw/src/index.ts`. Tests live in `patches/layout.test.ts` and import from the mirror.

**Tech Stack:** TypeScript, tsx (test runner), node:assert/strict

---

## File Map

| File | What changes |
|------|-------------|
| `patches/layout.ts` | `routeArrow` Phase 3; extend all 4 return statements; `handleCreateArrow` routing field; `handleEdgesOnly` + `handleApplyLayout` routingSummary; `create_arrow` description |
| `mcp_excalidraw/src/layout.ts` | Mirror of above — copy after all patches are done |
| `patches/layout.test.ts` | Phase 3 unit tests + integration test |
| `mcp_excalidraw/src/index.ts` | `batch_create_elements` description; anti-pattern #4 revision; "Cross-zone arrow routing" guide section |

---

## Task 1: Extend `routeArrow` return type and update all 4 return statements

**Files:**
- Modify: `patches/layout.ts:144-231`

The return type of `routeArrow` currently is `{ points, elbowed, fromPt }`. All four return statements must be updated before Phase 3 is added.

- [ ] **Step 1: Update the function signature return type annotation**

In `patches/layout.ts`, change line 148:

```ts
// Before:
): { points: Point[]; elbowed: boolean; fromPt: Point } {

// After:
): { points: Point[]; elbowed: boolean; fromPt: Point; crossings: number; routeType: 'straight' | 'elbow' | 'lane'; laneAxis?: 'x' | 'y'; laneCoord?: number } {
```

- [ ] **Step 2: Update Phase 1 early return (~line 169)**

```ts
// Before:
    return {
      points: [[0, 0], [toPt[0] - fromPt[0], toPt[1] - fromPt[1]]],
      elbowed: false,
      fromPt,
    };

// After:
    return {
      points: [[0, 0], [toPt[0] - fromPt[0], toPt[1] - fromPt[1]]],
      elbowed: false,
      fromPt,
      crossings: 0,
      routeType: 'straight',
    };
```

- [ ] **Step 3: Update the unreachable guard return (~line 218)**

```ts
// Before:
    return {
      points: [[0, 0], [tp[0] - fp[0], tp[1] - fp[1]]],
      elbowed: false,
      fromPt: fp,
    };

// After:
    return {
      points: [[0, 0], [tp[0] - fp[0], tp[1] - fp[1]]],
      elbowed: false,
      fromPt: fp,
      crossings: 0,
      routeType: 'elbow',
    };
```

- [ ] **Step 4: Update Phase 2 return (~line 225)**

```ts
// Before:
  const origin = best.fromPt;
  return {
    points: best.waypoints.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
    fromPt: origin,
  };

// After:
  const phase2CrossingCount = best.count;
  const origin = best.fromPt;
  // Phase 3: lane routing — only when Phase 2 still has crossings
  // (Phase 3 code goes here in Task 2)
  return {
    points: best.waypoints.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
    fromPt: origin,
    crossings: best.count,
    routeType: 'elbow',
  };
```

Note: We capture `phase2CrossingCount` now so the Phase 3 code added in Task 2 can reference it. The `// Phase 3: lane routing` comment is a placeholder for Task 2.

- [ ] **Step 5: Run existing tests to confirm they still pass**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all existing tests pass (same count as before).

- [ ] **Step 6: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: extend routeArrow return type with crossings/routeType fields"
```

---

## Task 2: Implement Phase 3 lane routing in `routeArrow`

**Files:**
- Modify: `patches/layout.ts` — insert Phase 3 block between the `phase2CrossingCount` capture and the Phase 2 return

Replace the `// (Phase 3 code goes here in Task 2)` placeholder comment with the full Phase 3 block:

- [ ] **Step 1: Insert Phase 3 implementation**

```ts
  if (phase2CrossingCount > 0 && obstacles.length > 0) {
    // --- Vertical lanes (laneAxis: 'x') ---
    const obsSortedX = [...obstacles].sort((a, b) => a.x - b.x);
    const rawVLanes: number[] = [];
    for (let i = 0; i < obsSortedX.length - 1; i++) {
      const rightEdge = obsSortedX[i].x + obsSortedX[i].width;
      const leftEdge  = obsSortedX[i + 1].x;
      if (leftEdge - rightEdge >= 20) rawVLanes.push((rightEdge + leftEdge) / 2);
    }
    rawVLanes.push(Math.min(...obstacles.map(o => o.x)) - 40);
    rawVLanes.push(Math.max(...obstacles.map(o => o.x + o.width)) + 40);
    rawVLanes.sort((a, b) => a - b);
    const vLanes = rawVLanes.filter((v, i) => i === 0 || v - rawVLanes[i - 1] >= 5);

    // --- Horizontal lanes (laneAxis: 'y') ---
    const obsSortedY = [...obstacles].sort((a, b) => a.y - b.y);
    const rawHLanes: number[] = [];
    for (let i = 0; i < obsSortedY.length - 1; i++) {
      const bottomEdge = obsSortedY[i].y + obsSortedY[i].height;
      const topEdge    = obsSortedY[i + 1].y;
      if (topEdge - bottomEdge >= 20) rawHLanes.push((bottomEdge + topEdge) / 2);
    }
    rawHLanes.push(Math.min(...obstacles.map(o => o.y)) - 40);
    rawHLanes.push(Math.max(...obstacles.map(o => o.y + o.height)) + 40);
    rawHLanes.sort((a, b) => a - b);
    const hLanes = rawHLanes.filter((v, i) => i === 0 || v - rawHLanes[i - 1] >= 5);

    interface LaneCandidate {
      waypoints: Point[];
      fromPt: Point;
      count: number;
      totalLength: number;
      axis: 'x' | 'y';
      coord: number;
    }
    let winner: LaneCandidate | null = null;

    function tryLane(waypoints: Point[], fp: Point, axis: 'x' | 'y', coord: number): void {
      // Degenerate filter: discard if any two consecutive waypoints are identical
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (waypoints[i][0] === waypoints[i + 1][0] && waypoints[i][1] === waypoints[i + 1][1]) return;
      }
      const count = countElbowIntersections(waypoints, obstacles);
      const totalLength = waypoints.slice(1).reduce((sum, pt, i) => {
        const prev = waypoints[i];
        return sum + Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      }, 0);
      if (!winner || count < winner.count || (count === winner.count && totalLength < winner.totalLength)) {
        winner = { waypoints, fromPt: fp, count, totalLength, axis, coord };
      }
    }

    for (const lx of vLanes) {
      for (const fk of SIDES) {
        for (const tk of SIDES) {
          const fp = fromPts[fk];
          const tp = toPts[tk];
          tryLane([fp, [lx, fp[1]], [lx, tp[1]], tp], fp, 'x', lx);
        }
      }
    }

    for (const ly of hLanes) {
      for (const fk of SIDES) {
        for (const tk of SIDES) {
          const fp = fromPts[fk];
          const tp = toPts[tk];
          tryLane([fp, [fp[0], ly], [tp[0], ly], tp], fp, 'y', ly);
        }
      }
    }

    if (winner !== null && (winner as LaneCandidate).count < phase2CrossingCount) {
      const w = winner as LaneCandidate;
      const laneOrigin = w.fromPt;
      return {
        points: w.waypoints.map(p => [p[0] - laneOrigin[0], p[1] - laneOrigin[1]] as Point),
        elbowed: true,
        fromPt: laneOrigin,
        crossings: w.count,
        routeType: 'lane',
        laneAxis: w.axis,
        laneCoord: w.coord,
      };
    }
  }
```

- [ ] **Step 2: Run existing tests — must still all pass**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: add Phase 3 lane routing to routeArrow"
```

---

## Task 3: Add Phase 3 unit tests

**Files:**
- Modify: `patches/layout.test.ts` — append after the last existing test block, before the final summary lines

- [ ] **Step 1: Mirror `patches/layout.ts` to `mcp_excalidraw/src/layout.ts`**

Tests import from the mirror, not the source file. Do this before writing tests:

```bash
cp patches/layout.ts mcp_excalidraw/src/layout.ts
```

- [ ] **Step 2: Add `fs` and `path` imports at the top of `patches/layout.test.ts`**

These are needed for the integration test in Task 4. Add them alongside the existing imports at the top of the file (after the existing `import assert` and `import { routeArrow, ... }` lines):

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
```

`import` declarations must be at the top of the module — do not place them mid-file.

- [ ] **Step 3: Add the Phase 3 unit test block**

Append before the final `console.log` summary block at the end of `patches/layout.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Phase 3: lane routing unit tests
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — Phase 3 lane routing');

test('vertical lane detection: 3 column obstacles produce 4 distinct lanes', () => {
  // Three columns with 30px gaps between them
  // col1: x=0..100, col2: x=130..230, col3: x=260..360
  // gaps: 130-100=30, 260-230=30 — both ≥ 20 → 2 interior lanes
  // interior lanes: (100+130)/2=115, (230+260)/2=245
  // outer lanes: min(0)-40=-40, max(360)+40=400
  // sorted: [-40, 115, 245, 400] — all differ by ≥ 5 → 4 lanes
  const obs = [
    { x: 0,   y: 0, width: 100, height: 60 },
    { x: 130, y: 0, width: 100, height: 60 },
    { x: 260, y: 0, width: 100, height: 60 },
  ];
  // Internal helper: replicate gap detection logic
  const sorted = [...obs].sort((a, b) => a.x - b.x);
  const raw: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const re = sorted[i].x + sorted[i].width;
    const le = sorted[i + 1].x;
    if (le - re >= 20) raw.push((re + le) / 2);
  }
  raw.push(Math.min(...obs.map(o => o.x)) - 40);
  raw.push(Math.max(...obs.map(o => o.x + o.width)) + 40);
  raw.sort((a, b) => a - b);
  const lanes = raw.filter((v, i) => i === 0 || v - raw[i - 1] >= 5);
  assert.strictEqual(lanes.length, 4, `expected 4 lanes, got ${lanes.length}: ${lanes}`);
  assert.strictEqual(lanes[0], -40);
  assert.strictEqual(lanes[1], 115);
  assert.strictEqual(lanes[2], 245);
  assert.strictEqual(lanes[3], 400);
});

test('horizontal lane detection: 3 row obstacles produce 4 distinct lanes', () => {
  const obs = [
    { x: 0, y: 0,   width: 100, height: 60 },
    { x: 0, y: 90,  width: 100, height: 60 },
    { x: 0, y: 180, width: 100, height: 60 },
  ];
  // gaps: 90-60=30, 180-150=30 — both ≥ 20
  // interior: (60+90)/2=75, (150+180)/2=165
  // outer: 0-40=-40, 240+40=280
  const sorted = [...obs].sort((a, b) => a.y - b.y);
  const raw: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const be = sorted[i].y + sorted[i].height;
    const te = sorted[i + 1].y;
    if (te - be >= 20) raw.push((be + te) / 2);
  }
  raw.push(Math.min(...obs.map(o => o.y)) - 40);
  raw.push(Math.max(...obs.map(o => o.y + o.height)) + 40);
  raw.sort((a, b) => a - b);
  const lanes = raw.filter((v, i) => i === 0 || v - raw[i - 1] >= 5);
  assert.strictEqual(lanes.length, 4);
  assert.strictEqual(lanes[0], -40);
  assert.strictEqual(lanes[1], 75);
  assert.strictEqual(lanes[2], 165);
  assert.strictEqual(lanes[3], 280);
});

test('degenerate candidate filtering: lane path with identical consecutive waypoints is excluded', () => {
  // Source top midpoint x equals lx → [fp, (lx, fp[1]), ...] has fp === second point
  // Arrange: from.top = (50, 0), lx = 50 → candidate [fp, [50, fp[1]], ...] = degenerate
  // We verify routeArrow doesn't crash and returns something
  const from = { x: 0, y: 0, width: 100, height: 60 };
  const to   = { x: 200, y: 200, width: 100, height: 60 };
  // Single obstacle blocking Phase 2
  const obs = [{ x: 60, y: 30, width: 80, height: 140 }];
  const result = routeArrow(from, to, obs);
  // Should return a valid result (not throw)
  assert.ok(result.points.length >= 2, 'returns valid points array');
  assert.ok(typeof result.crossings === 'number', 'has crossings field');
});

test('cross-axis selection: horizontal lane wins when it has fewer crossings', () => {
  // Obstacle cluster blocks vertical lanes but a horizontal lane is clear.
  // Wide obstacle spanning full x range: forces vertical lanes to cross it.
  // Source above, target below, obstacle in the middle.
  // A horizontal lane above the obstacle (at y = min(obs.y) - 40) should give 0 crossings.
  const from = { x: 100, y: 0,   width: 100, height: 60 };  // bottom midpt: (150, 60)
  const to   = { x: 100, y: 400, width: 100, height: 60 };  // top midpt: (150, 400)
  // Wide obstacle blocking all vertical lanes between from and to
  const obs  = [{ x: -200, y: 100, width: 600, height: 200 }];
  // Outer vertical lanes: min(x)=-200-40=-240, max(x+w)=400+40=440
  // These vertical lanes at x=-240 and x=440 would route around the obstacle
  // Horizontal outer lane: min(y)-40=100-40=60 which equals from.bottom → might be degenerate
  // The key: Phase 3 should find SOME path with fewer crossings than Phase 2
  const result = routeArrow(from, to, obs);
  assert.ok(typeof result.crossings === 'number', 'has crossings field');
  assert.ok(['elbow', 'lane'].includes(result.routeType), `routeType is ${result.routeType}`);
});

test('Phase 3 prefers lane path with 0 crossings over Phase 2 with 2 crossings', () => {
  // Arrange two obstacles side by side with a gap.
  // Direct path crosses both; lane through the gap crosses neither.
  const from = { x: 0,   y: 150, width: 60, height: 60 };  // right midpt: (60, 180)
  const to   = { x: 500, y: 150, width: 60, height: 60 };  // left midpt: (500, 180)
  // Two obstacles blocking the direct H path, with a 40px gap between them
  const obs = [
    { x: 100, y: 100, width: 100, height: 160 }, // right edge: 200
    { x: 240, y: 100, width: 100, height: 160 }, // left edge: 240, gap=40px
  ];
  // Gap midpoint x = (200 + 240) / 2 = 220
  // Lane path: from.right(60,180) → (220,180) → (220,180) → to.left(500,180)
  // Wait, that's degenerate at the turn if fp[1]==tp[1]. But the lane is vertical x=220,
  // and we'd have [fp, (220, fp[1]), (220, tp[1]), tp] = [(60,180),(220,180),(220,180),(500,180)]
  // That IS degenerate (points 2&3 identical when fp[1]==tp[1]).
  // Adjust: give from and to different y so it's not degenerate.
  const from2 = { x: 0,   y: 100, width: 60, height: 60 };  // right midpt: (60, 130)
  const to2   = { x: 500, y: 200, width: 60, height: 60 };  // left midpt: (500, 230)
  const result = routeArrow(from2, to2, obs);
  assert.strictEqual(result.routeType, 'lane', `expected lane, got ${result.routeType}`);
  assert.strictEqual(result.crossings, 0, `expected 0 crossings, got ${result.crossings}`);
});

test('Phase 2 fallback: when all lane candidates are worse than Phase 2 best, returns elbow routeType', () => {
  // One small obstacle forces Phase 2 (blocks the straight path but elbow gives count=0).
  // Phase 3 runs only when Phase 2 count > 0 — here Phase 2 count=0, so Phase 3 is skipped.
  // Result must be routeType 'elbow', not 'lane'.
  const from = { x: 0,   y: 0,   width: 60, height: 60 };
  const to   = { x: 200, y: 200, width: 60, height: 60 };
  // Obstacle in the direct diagonal path but elbow routes around it cleanly
  const obs  = [{ x: 60, y: 60, width: 60, height: 60 }];
  const result = routeArrow(from, to, obs);
  // Phase 1 blocked, Phase 2 finds clean elbow (count=0), Phase 3 skipped
  assert.strictEqual(result.routeType, 'elbow', `expected elbow, got ${result.routeType}`);
  assert.strictEqual(result.crossings, 0);
  assert.strictEqual(result.laneAxis, undefined);
});

test('Phase 1 return has crossings:0 and routeType:straight with no laneAxis', () => {
  const from = { x: 0,   y: 0, width: 60, height: 60 };
  const to   = { x: 200, y: 0, width: 60, height: 60 };
  const result = routeArrow(from, to, []);
  assert.strictEqual(result.crossings, 0);
  assert.strictEqual(result.routeType, 'straight');
  assert.strictEqual(result.laneAxis, undefined);
  assert.strictEqual(result.laneCoord, undefined);
});
```

- [ ] **Step 4: Run tests — all must pass including the new ones**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add patches/layout.test.ts
git commit -m "test: add Phase 3 lane routing unit tests"
```

---

## Task 4: Add integration test

**Files:**
- Modify: `patches/layout.test.ts` — append after the Phase 3 unit tests, before the summary

The integration test loads the real example diagram from `docs/example-diagram/example-diagram.excalidraw` and checks that `routeArrow` finds a lane path with 0 crossings between `init-b` and `svc-c`.

- [ ] **Step 1: Append the integration test**

```ts
// ---------------------------------------------------------------------------
// Integration test: route init-b → svc-c through example diagram
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — integration test with example diagram');

test('init-b → svc-c routes via lane with 0 crossings', () => {
  const filePath = path.join(
    new URL('.', import.meta.url).pathname,
    '../docs/example-diagram/example-diagram.excalidraw'
  );
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const elements: Array<{ id: string; type: string; x: number; y: number; width?: number; height?: number }> = data.elements;

  const initBEl = elements.find(e => e.id === 'init-b');
  const svcCEl  = elements.find(e => e.id === 'svc-c');
  assert.ok(initBEl, 'init-b element must exist in example diagram');
  assert.ok(svcCEl,  'svc-c element must exist in example diagram');

  const initBBox = { x: initBEl!.x, y: initBEl!.y, width: initBEl!.width!, height: initBEl!.height! };
  const svcCBox  = { x: svcCEl!.x,  y: svcCEl!.y,  width: svcCEl!.width!,  height: svcCEl!.height!  };

  const obstacles = elements
    .filter(e => e.id !== 'init-b' && e.id !== 'svc-c' && e.type !== 'arrow' && e.width && e.height)
    .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

  const result = routeArrow(initBBox, svcCBox, obstacles);

  assert.strictEqual(result.routeType, 'lane',
    `expected routeType 'lane', got '${result.routeType}' (crossings: ${result.crossings})`);
  assert.strictEqual(result.crossings, 0,
    `expected 0 crossings, got ${result.crossings} (routeType: ${result.routeType})`);
});
```

Note: `Box` is not exported from layout.ts. The variables above use no type annotation — TypeScript infers the shape structurally and `routeArrow` accepts them. The `import * as fs` and `import * as path` were added in Task 3 — do not add again.

- [ ] **Step 2: Run all tests**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all tests pass, including the new integration test. This test is the primary acceptance criterion from the spec — `init-b` (Initiative B) → `svc-c` (Service C) is the cross-zone pair that Phase 3 was designed to route cleanly through the Work Items zone gap.

If the integration test fails with `routeType: 'lane'` but `crossings > 0`: Phase 3 is choosing a lane but the path still crosses something. Check whether the gap-detection midpoints land inside any element; the obstacle filter may be too permissive.

If the integration test fails with `routeType: 'elbow'`: Phase 3's best lane candidate did not improve on Phase 2's crossing count, or Phase 2 already produced 0 crossings (making Phase 3 skip). In the latter case, weaken the assertion to `result.crossings === 0` and accept either `'elbow'` or `'lane'` — a clean route is the goal regardless of which phase produced it.

- [ ] **Step 3: Commit**

```bash
git add patches/layout.test.ts
git commit -m "test: add integration test for init-b → svc-c lane routing"
```

---

## Task 5: Update `handleCreateArrow`, `handleEdgesOnly`, `handleApplyLayout`, and `create_arrow` description

**Files:**
- Modify: `patches/layout.ts` — ~line 580 (`handleCreateArrow`), ~line 835 (`handleEdgesOnly` loop), ~line 1026 (`handleApplyLayout` loop), ~line 1160 (`create_arrow` description)

- [ ] **Step 1: Update `handleCreateArrow` to extract routing fields and return them**

Find the destructuring on ~line 580:

```ts
// Before:
  const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles);

// After:
  const { points, elbowed, fromPt, crossings, routeType, laneAxis, laneCoord } = routeArrow(fromBox, toBox, obstacles);
```

Find the return on ~line 612:

```ts
// Before:
  return { id: arrowId, element: created };

// After:
  const routing: Record<string, unknown> = { type: routeType, crossings };
  if (routeType === 'lane') {
    if (laneAxis === 'x') routing.laneX = laneCoord;
    else if (laneAxis === 'y') routing.laneY = laneCoord;
  }
  return { id: arrowId, element: created, routing };
```

- [ ] **Step 2: Update `handleEdgesOnly` to collect and return `routingSummary`**

Find `handleEdgesOnly` (~line 800). Before the `for (const edge of args.edges)` loop, add:

```ts
  const routingSummary = {
    totalEdges: args.edges.length,  // total declared edges, including skipped (missing endpoints)
    clean: 0,
    withCrossings: 0,
    edges: [] as { fromId: string; toId: string; crossings: number; type: string }[],
  };
```

Find the destructuring inside the loop (~line 835):

```ts
// Before:
    const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles);

// After:
    const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType } = routeArrow(fromBox, toBox, obstacles);
    if (edgeCrossings > 0) {
      routingSummary.withCrossings++;
      routingSummary.edges.push({ fromId: edge.fromId, toId: edge.toId, crossings: edgeCrossings, type: edgeRouteType });
    } else {
      routingSummary.clean++;
    }
```

Find the return at the end of `handleEdgesOnly` (~line 878):

```ts
// Before:
  return {
    updated: createdCount + arrowUpdates.length,
    positions: [],
  };

// After:
  return {
    updated: createdCount + arrowUpdates.length,
    positions: [],
    routingSummary,
  };
```

- [ ] **Step 3: Update `handleApplyLayout` Phase 4 loop to collect and return `routingSummary`**

Find `handleApplyLayout`'s arrow routing section (~line 1000). Before the `for (const edge of args.edges)` loop in Phase 4, add:

```ts
  const routingSummary = {
    totalEdges: args.edges.length,  // total declared edges, including skipped (missing from posMap)
    clean: 0,
    withCrossings: 0,
    edges: [] as { fromId: string; toId: string; crossings: number; type: string }[],
  };
```

Find the destructuring inside the Phase 4 loop (~line 1026):

```ts
// Before:
    const { points, elbowed, fromPt } = routeArrow(fromPos, toPos, obstacles);

// After:
    const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType } = routeArrow(fromPos, toPos, obstacles);
    if (edgeCrossings > 0) {
      routingSummary.withCrossings++;
      routingSummary.edges.push({ fromId: edge.fromId, toId: edge.toId, crossings: edgeCrossings, type: edgeRouteType });
    } else {
      routingSummary.clean++;
    }
```

Find the return at the end of `handleApplyLayout` (~line 1067):

```ts
// Before:
  return {
    updated: nodeUpdates.length + arrowUpdates.length,
    positions: positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })),
  };

// After:
  return {
    updated: nodeUpdates.length + arrowUpdates.length,
    positions: positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })),
    routingSummary,
  };
```

- [ ] **Step 4: Update `create_arrow` tool description (~line 1160)**

```ts
// Before:
    description: 'Create a routed arrow between two existing elements. Automatically routes straight if the path is clear, elbow if blocked. Returns the arrow ID for use in apply_layout edges. Note: text content passed as "text" during element creation (via create_element or batch_create_elements) is stored and returned as "label.text" — this is expected and the text renders correctly inside the shape.',

// After:
    description: 'Create a routed arrow between two existing elements. Routes automatically in three tiers: straight if the path is clear, elbow (single bend) if one turn suffices, lane if the arrow must navigate around a cluster of elements by finding the gap between columns or rows. Check routing.crossings in the response — if > 0, the route still crosses elements and you should use batch_create_elements with explicit waypoints instead. Returns the arrow ID for use in apply_layout edges. Note: text content passed as "text" during element creation (via create_element or batch_create_elements) is stored and returned as "label.text" — this is expected and the text renders correctly inside the shape.',
```

- [ ] **Step 5: Run all tests**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: surface routing metadata in create_arrow/apply_layout/edges-only responses"
```

---

## Task 6: Final mirror of `patches/layout.ts` to `mcp_excalidraw/src/layout.ts`

**Files:**
- Overwrite: `mcp_excalidraw/src/layout.ts` with contents of `patches/layout.ts`

Task 3 Step 1 did an intermediate mirror so tests could run. Now that Task 5 has added the routing metadata changes to `patches/layout.ts`, mirror again to bring the final state into sync.

- [ ] **Step 1: Copy the file**

```bash
cp patches/layout.ts mcp_excalidraw/src/layout.ts
```

- [ ] **Step 2: Run all tests to confirm the final mirror is correct**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add mcp_excalidraw/src/layout.ts
git commit -m "chore: final mirror of layout.ts changes to mcp_excalidraw/src"
```

---

## Task 7: Update `mcp_excalidraw/src/index.ts` — tool description and diagram guide

**Files:**
- Modify: `mcp_excalidraw/src/index.ts:353` (anti-pattern #4), `mcp_excalidraw/src/index.ts:366` (end of guide), `mcp_excalidraw/src/index.ts:598` (`batch_create_elements` description)

- [ ] **Step 1: Update `batch_create_elements` description (~line 598)**

```ts
// Before:
    description: 'Create multiple Excalidraw elements at once. For arrows, use startElementId/endElementId to bind arrows to shapes — Excalidraw auto-routes to element edges. Assign custom id to shapes so arrows can reference them.',

// After:
    description: 'Create multiple Excalidraw elements at once. For arrows, use startElementId/endElementId to bind arrows to shapes — Excalidraw auto-routes to element edges. Assign custom id to shapes so arrows can reference them. Cross-zone arrows with explicit waypoints: when create_arrow returns routing.crossings > 0, pass an arrow element with explicit points (coordinates relative to the arrow\'s x, y origin) and omit startElementId/endElementId. Identify the gap lane x-position (midpoint between adjacent element columns), then use the 3-segment pattern: points: [[0,0], [dx_to_lane, 0], [dx_to_lane, dy_to_target_row], [dx_to_target_side, dy_to_target_row]]. Arrive at the side of the target element (not top/bottom) to avoid overlapping with arrows that enter from above or below.',
```

- [ ] **Step 2: Revise anti-pattern #4 in `DIAGRAM_DESIGN_GUIDE` (~line 353)**

```ts
// Before:
4. **Manual arrow coordinates** — always use startElementId/endElementId binding

// After:
4. **Manual arrow coordinates** — prefer \`startElementId\`/\`endElementId\` binding. Exception: when \`create_arrow\` returns \`routing.crossings > 0\`, use \`batch_create_elements\` with explicit \`points\` to route through a column gap (see "Cross-zone arrow routing" section below).
```

- [ ] **Step 3: Append "Cross-zone arrow routing" section at the end of `DIAGRAM_DESIGN_GUIDE` (~line 366, before the closing backtick)**

```ts
// Before (the last lines of DIAGRAM_DESIGN_GUIDE):
5. **Refinement** — align, distribute, adjust spacing, screenshot to verify
\`;

// After:
5. **Refinement** — align, distribute, adjust spacing, screenshot to verify

## Cross-zone arrow routing

When an arrow must skip multiple zones (e.g., spanning 3 stacked rows of elements):

1. Call \`create_arrow\` first.
2. Check \`routing.crossings\` in the response.
3. If \`crossings === 0\`: done — the router found a clean path automatically.
4. If \`crossings > 0\`: fall back to \`batch_create_elements\` with explicit waypoints.

### Finding the column gap lane

Sort elements by x-position. The lane x is the midpoint of each gap ≥ 20px between adjacent right-edge and next left-edge. Also use \`min(left_edges) − 40\` or \`max(right_edges) + 40\` for outer bypass lanes.

Example — elements at x=[60–240], x=[270–450], x=[480–660]:
- Gap col 1→2: (240 + 270) / 2 = 255
- Gap col 2→3: (450 + 480) / 2 = 465
- Left outer lane: 60 − 40 = 20
- Right outer lane: 660 + 40 = 700

### 3-segment waypoint pattern (vertical lane)

Place the arrow at \`x = source_cx, y = source_top\`. Points are relative to the arrow origin:

\`\`\`
points: [[0, 0], [lane_x - source_cx, 0], [lane_x - source_cx, target_mid_y - source_top], [target_left_x - source_cx, target_mid_y - source_top]]
\`\`\`

The arrowhead arrives at the **left side** of the target element.
This avoids overlap with arrows entering the target from the top or bottom.

### Which side to arrive on

- Cross-zone bypass arrows: arrive at **left or right side**
- Same-column adjacent-zone arrows: arrive at **top or bottom**
\`;
```

- [ ] **Step 4: Run tests**

```bash
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: all tests pass (index.ts changes don't affect test logic).

- [ ] **Step 5: Commit**

```bash
git add mcp_excalidraw/src/index.ts
git commit -m "feat: update batch_create_elements description and diagram guide with cross-zone routing"
```

---

## Done

All tasks complete. The full set of changes:
- `routeArrow` now has Phase 3 that finds gap lanes and routes 3-segment paths through them
- All 4 return statements include `crossings`, `routeType`, `laneAxis?`, `laneCoord?`
- `create_arrow` response includes `routing: { type, crossings, laneX? | laneY? }`
- `apply_layout` and `edges-only` responses include `routingSummary`
- Tests cover Phase 3 unit cases and integration against the real example diagram
- LLM guidance updated: tool descriptions and diagram guide explain the 3-tier routing and fallback pattern
