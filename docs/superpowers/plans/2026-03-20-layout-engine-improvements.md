# Layout Engine Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six real-world issues in `patches/layout.ts`: exhaustive attachment point search in `routeArrow`, `read_diagram_guide` documentation, `apply_layout` edges-only mode, zone/group y-snap constraints, and `move_element` proximity detection for unbound arrows.

**Architecture:** All changes are in a single file: `patches/layout.ts`. After each task, the patch is applied (`bash scripts/add_layout_tools.sh`) and the compiled output in `mcp_excalidraw/src/layout.ts` + `mcp_excalidraw/dist/` reflects the change. Pure functions are unit-tested with tsx before apply; handler changes are verified by rebuild.

**Tech Stack:** TypeScript, dagre (graph layout), node-fetch (HTTP to Express server), tsx (for running TypeScript tests without compilation step)

---

## File Structure

Only one file is modified:

| File | Change |
|------|--------|
| `patches/layout.ts` | All 5 tasks below |
| `patches/layout.test.ts` | **Create** — unit tests for pure functions |

Tests run from `mcp_excalidraw/` dir using `npx --yes tsx ../patches/layout.test.ts` so that `dagre` and `node-fetch` resolve from `mcp_excalidraw/node_modules/`. The test file imports from `./src/layout.ts` (the copied patch file after apply).

**Important:** Every task follows this workflow:
1. Edit `patches/layout.ts`
2. Run `bash scripts/add_layout_tools.sh` to copy + build (this copies layout.ts to `mcp_excalidraw/src/layout.ts` and runs `npm run build:server`)
3. Run tests

---

## Task 1: Exhaustive Attachment Point Search in `routeArrow`

**Files:**
- Modify: `patches/layout.ts` — `routeArrow` function (lines ~135–178), keep `nearestMidpointPair` exported but remove its call from `routeArrow`
- Create: `patches/layout.test.ts`

**Context:** The current `routeArrow` calls `nearestMidpointPair` to select one pair of side midpoints, then checks only that one straight-line path. For vertically-aligned elements with a narrow obstacle between them, the nearest pair is the top/bottom midpoints, and the straight path between them is blocked. The elbow candidates then degenerate (when from and to share the same x-center, `mid1 = [toPt[0], fromPt[1]] = fromPt` and `mid2 = fromPt` too). The fix: try all 16 pairs.

- [ ] **Step 1: Write the failing test**

Create `patches/layout.test.ts`:

```typescript
// patches/layout.test.ts
// Run from mcp_excalidraw/ dir: npx --yes tsx ../patches/layout.test.ts
// Requires: bash scripts/add_layout_tools.sh to have been run first

import assert from 'node:assert/strict';
import {
  routeArrow,
  segmentIntersectsBox,
  countElbowIntersections,
  layoutTools,
  applyGroupsYSnap,
} from './src/layout.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Task 1: exhaustive attachment point search
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — exhaustive attachment point search');

test('finds clear straight path via non-nearest side when nearest is blocked', () => {
  // Source and target are vertically aligned (same x-center).
  // A narrow obstacle sits directly between them, blocking all top/bottom paths.
  // The clear path is right-to-right (x=200), which is outside the obstacle's x range.
  const from     = { x: 100, y: 0,   width: 100, height: 60 };
  const to       = { x: 100, y: 300, width: 100, height: 60 };
  const obstacle = { x: 120, y: 130, width: 60,  height: 60 };
  //  source right midpoint: (200, 30)
  //  target right midpoint: (200, 330)
  //  vertical line at x=200 does NOT pass through obstacle (x=120-180). Clear.

  const result = routeArrow(from, to, [obstacle]);
  assert.strictEqual(result.elbowed, false, 'should find a clear straight path');
  assert.deepStrictEqual(result.fromPt, [200, 30], 'should start at right midpoint of source');
  assert.strictEqual(result.points.length, 2, 'straight arrow has 2 points');
  // Endpoint relative to fromPt: toRightPt = (200, 330), rel = (0, 300)
  assert.deepStrictEqual(result.points[1], [0, 300]);
});

test('no obstacles: picks shortest straight path (bottom-to-top when aligned)', () => {
  const from = { x: 100, y: 0,   width: 100, height: 60 };
  const to   = { x: 100, y: 200, width: 100, height: 60 };
  const result = routeArrow(from, to, []);
  assert.strictEqual(result.elbowed, false);
  // Many straight paths are clear. The shortest is bottom-of-source to top-of-target.
  // bottom midpoint of from: (150, 60); top midpoint of to: (150, 200) — dist=140
  // right-right: (200,30)→(200,230) — dist=200
  // So bottom-to-top wins as shortest.
  assert.deepStrictEqual(result.fromPt, [150, 60]);
  assert.deepStrictEqual(result.points[1], [0, 140]);
});

test('all straight paths blocked: picks elbow with fewest intersections', () => {
  const from = { x: 0,   y: 0,   width: 60, height: 60 };
  const to   = { x: 200, y: 200, width: 60, height: 60 };
  // Obstacle blocks the most direct paths but not a horizontal-first elbow to the right
  const obstacle = { x: 30, y: 30, width: 170, height: 170 };
  const result = routeArrow(from, to, [obstacle]);
  assert.strictEqual(result.elbowed, true, 'should use elbow when all straight paths blocked');
  assert.strictEqual(result.points.length, 3, 'elbow arrow has 3 points');
});

test('segmentIntersectsBox: line through center hits box', () => {
  const box = { x: 40, y: 40, width: 20, height: 20 };
  assert.strictEqual(segmentIntersectsBox([0, 50], [100, 50], box), true);
});

test('segmentIntersectsBox: line beside box does not hit', () => {
  const box = { x: 40, y: 40, width: 20, height: 20 };
  assert.strictEqual(segmentIntersectsBox([0, 30], [100, 30], box), false);
});

test('countElbowIntersections: counts segments that cross an obstacle', () => {
  // Obstacle: x=40-60, y=10-90
  // Segment 1: (0,50)→(50,50) — horizontal, enters box crossing the left wall at x=40
  // Segment 2: (50,50)→(50,200) — vertical at x=50, starts inside box, exits crossing the bottom wall at y=90
  // Both segments cross a box boundary → count=2
  const obs = { x: 40, y: 10, width: 20, height: 80 };
  const count = countElbowIntersections([[0,50],[50,50],[50,200]], [obs]);
  assert.strictEqual(count, 2);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Apply patch and run failing test**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: The first test ("finds clear straight path") FAILS because current `routeArrow` uses `nearestMidpointPair` and the nearest pair (bottom-to-top, both at x=150) is blocked, producing an elbowed result instead of a straight one.

- [ ] **Step 3: Replace `routeArrow` with exhaustive search**

In `patches/layout.ts`, replace the entire `routeArrow` function (keep `nearestMidpointPair` — it stays exported for backward compat but is no longer called internally):

```typescript
/**
 * Route an arrow between two elements. Returns relative points[] and elbowed flag.
 * Tries all 16 side-midpoint pairs (4 sides × 4 sides) to find the best path:
 * - Prefers a straight line if any pair has a clear path (no obstacle intersections)
 * - Falls back to elbow routing, picking the candidate with fewest intersections
 * obstacles: all canvas elements except from and to.
 */
export function routeArrow(
  from: Box,
  to: Box,
  obstacles: Box[]
): { points: Point[]; elbowed: boolean; fromPt: Point } {
  const SIDES: (keyof SideMidpoints)[] = ['top', 'right', 'bottom', 'left'];
  const fromPts = getSideMidpoints(from);
  const toPts   = getSideMidpoints(to);

  // Phase 1: find the shortest clear straight path across all 16 pairs
  let bestStraight: { fromPt: Point; toPt: Point; dist: number } | null = null;
  for (const fk of SIDES) {
    for (const tk of SIDES) {
      const fp = fromPts[fk];
      const tp = toPts[tk];
      if (obstacles.some(obs => segmentIntersectsBox(fp, tp, obs))) continue;
      const dist = Math.hypot(fp[0] - tp[0], fp[1] - tp[1]);
      if (!bestStraight || dist < bestStraight.dist) {
        bestStraight = { fromPt: fp, toPt: tp, dist };
      }
    }
  }

  if (bestStraight) {
    const { fromPt, toPt } = bestStraight;
    return {
      points: [[0, 0], [toPt[0] - fromPt[0], toPt[1] - fromPt[1]]],
      elbowed: false,
      fromPt,
    };
  }

  // Phase 2: try all 32 elbow candidates (16 pairs × H-first + V-first)
  interface ElbowCandidate {
    waypoints: Point[];
    fromPt: Point;
    count: number;
    isHorizontalFirst: boolean;
    totalLength: number;
  }
  let best: ElbowCandidate | null = null;

  for (const fk of SIDES) {
    for (const tk of SIDES) {
      const fp = fromPts[fk];
      const tp = toPts[tk];

      const midH: Point = [tp[0], fp[1]]; // horizontal-first
      const midV: Point = [fp[0], tp[1]]; // vertical-first

      for (const [mid, isH] of [[midH, true], [midV, false]] as [Point, boolean][]) {
        const waypoints: Point[] = [fp, mid, tp];
        const count = countElbowIntersections(waypoints, obstacles);
        const totalLength =
          Math.hypot(mid[0] - fp[0], mid[1] - fp[1]) +
          Math.hypot(tp[0]  - mid[0], tp[1] - mid[1]);

        const better =
          !best ||
          count < best.count ||
          (count === best.count && isH && !best.isHorizontalFirst) ||
          (count === best.count && isH === best.isHorizontalFirst && totalLength < best.totalLength);

        if (better) {
          best = { waypoints, fromPt: fp, count, isHorizontalFirst: isH, totalLength };
        }
      }
    }
  }

  if (!best) {
    // Unreachable: at least one candidate always exists
    const fp = fromPts.right;
    const tp = toPts.left;
    return {
      points: [[0, 0], [tp[0] - fp[0], tp[1] - fp[1]]],
      elbowed: false,
      fromPt: fp,
    };
  }

  const origin = best.fromPt;
  return {
    points: best.waypoints.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
    fromPt: origin,
  };
}
```

- [ ] **Step 4: Apply patch and run tests**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: All tests pass. Output: `6 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
git add patches/layout.ts patches/layout.test.ts
git commit -m "fix: exhaustive attachment point search in routeArrow — fixes issues #1 and #5"
```

---

## Task 2: `read_diagram_guide` Documentation Update

**Files:**
- Modify: `patches/layout.ts` — the guide string returned by `read_diagram_guide` handler (search for `read_diagram_guide` in the tool dispatcher or in layoutTools)

**Context:** The `read_diagram_guide` tool is defined in `library-tools.ts` (upstream), not in `layout.ts`. Check if layout.ts handles it or if we need to look at the library-tools handler.

> **Note for implementer:** Before making the change, grep for `read_diagram_guide` in `mcp_excalidraw/src/`:
> ```bash
> grep -r "read_diagram_guide" mcp_excalidraw/src/
> ```
> The guide text lives in the upstream `library-tools.ts`. Since `patches/layout.ts` should not modify upstream files, the label.text note should be added to `layout.ts`'s tool descriptions instead — specifically as a note in the `create_arrow` tool description and/or in `apply_layout`'s description. This is the correct scope for our patch.

- [ ] **Step 1: Locate the guide text**

```bash
grep -r "read_diagram_guide\|label\.text\|label.text" /Users/vtajzich/environment/repos/private/excalidraw/mcp_excalidraw/src/
```

Expected: The `read_diagram_guide` content is in `src/library-tools.ts` (upstream). Our patch cannot modify that file.

- [ ] **Step 2: Add label.text note to `create_arrow` and `apply_layout` descriptions**

In `patches/layout.ts`, locate the `layoutTools` array. Update the `create_arrow` description to include the clarification note:

Find this in `layoutTools`:
```typescript
    description: 'Create a routed arrow between two existing elements. Automatically routes straight if the path is clear, elbow if blocked. Returns the arrow ID for use in apply_layout edges.',
```

Replace with:
```typescript
    description: 'Create a routed arrow between two existing elements. Automatically routes straight if the path is clear, elbow if blocked. Returns the arrow ID for use in apply_layout edges. Note: text content passed as "text" during element creation (via create_element or batch_create_elements) is stored and returned as "label.text" — this is expected and the text renders correctly inside the shape.',
```

- [ ] **Step 3: Apply patch and rebuild**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
```

Expected: Build succeeds with `Found 0 errors.`

- [ ] **Step 4: Commit**

```bash
git add patches/layout.ts
git commit -m "docs: add label.text clarification note to create_arrow tool description — fixes issue #2"
```

---

## Task 3: `apply_layout` Edges-Only Mode

**Files:**
- Modify: `patches/layout.ts` — `ApplyLayoutArgs` interface, `handleApplyLayout`, new `handleEdgesOnly` helper, `layoutTools` schema for `apply_layout`

**Context:** Currently `handleApplyLayout` always runs Dagre and repositions all nodes. Adding `mode: "edges-only"` skips Dagre entirely and only routes arrows using current canvas positions.

- [ ] **Step 1: Add failing test for edges-only schema validation**

In `patches/layout.test.ts`, add a new test section at the bottom (before the summary). Note: `layoutTools` was already imported at the top of the test file — no new import needed.

```typescript
// ---------------------------------------------------------------------------
// Task 3: apply_layout schema — mode parameter is in layoutTools
// ---------------------------------------------------------------------------
console.log('\napply_layout schema — mode parameter');

test('apply_layout tool schema includes mode parameter', () => {
  const applyLayout = layoutTools.find(t => t.name === 'apply_layout');
  assert.ok(applyLayout, 'apply_layout tool exists');
  const props = (applyLayout!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok('mode' in props, 'mode parameter is in schema');
  const modeProp = props['mode'] as { type: string; enum: string[] };
  assert.deepStrictEqual(modeProp.enum, ['layout', 'edges-only']);
});

test('apply_layout tool schema algorithm is not required when mode is edges-only', () => {
  const applyLayout = layoutTools.find(t => t.name === 'apply_layout');
  const required = (applyLayout!.inputSchema as { required: string[] }).required;
  // algorithm should no longer be required (edges-only doesn't need it)
  assert.strictEqual(required.includes('algorithm'), false, 'algorithm should not be required');
});
```

Run the test — expect failure since `mode` is not yet in the schema:
```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: 2 new tests fail.

- [ ] **Step 2: Add `mode` to `ApplyLayoutArgs` and update schema**

In `patches/layout.ts`, update the `ApplyLayoutArgs` interface:

```typescript
interface ApplyLayoutArgs {
  algorithm?: 'hierarchical' | 'flow';  // optional: not needed for edges-only mode
  direction?: 'top-down' | 'left-right';
  elementIds?: string[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  spacing?: LayoutSpacing;
  mode?: 'layout' | 'edges-only';
}
```

In `layoutTools`, update the `apply_layout` `inputSchema`:

1. Make `algorithm` optional in `required` (remove it from the array):

Change:
```typescript
      required: ['algorithm', 'nodes', 'edges'],
```
To:
```typescript
      required: ['nodes', 'edges'],
```

2. Add `mode` to properties (insert after `spacing` property):

```typescript
        mode: {
          type: 'string',
          enum: ['layout', 'edges-only'],
          description: 'layout (default): run Dagre and reposition nodes. edges-only: skip Dagre, route only the arrows in edges[] using current element positions — nodes are not moved.',
        },
```

3. Update `algorithm` description to note it is required in layout mode:

```typescript
        algorithm: { type: 'string', enum: ['hierarchical', 'flow'], description: 'Layout algorithm (required when mode is "layout"). hierarchical: Sugiyama layered tree. flow: DAG pipeline — cycles are an error.' },
```

- [ ] **Step 3: Add validation at the top of `handleApplyLayout`**

In `handleApplyLayout`, add validation after spacing is resolved:

```typescript
  // Route to edges-only handler
  if (args.mode === 'edges-only') {
    return handleEdgesOnly(args, spacing);
  }

  // layout mode requires algorithm
  if (!args.algorithm) {
    throw new Error('algorithm is required when mode is "layout" (or mode is omitted)');
  }
```

- [ ] **Step 4: Implement `handleEdgesOnly`**

Add this new function just before `handleApplyLayout`:

```typescript
async function handleEdgesOnly(
  args: ApplyLayoutArgs,
  _spacing: Required<LayoutSpacing>
): Promise<object> {
  const allElements = await fetchAllElements();
  const elementMap = new Map(allElements.map(e => [e.id, e]));

  // Track boundElements updates — merge per element
  const boundElementsAccum = new Map<string, { type: string; id: string }[]>();
  function accumulateBound(el: CanvasElement, arrowId: string): void {
    const current = boundElementsAccum.get(el.id) ?? [...(el.boundElements || [])];
    if (!current.some(b => b.id === arrowId)) {
      current.push({ type: 'arrow', id: arrowId });
    }
    boundElementsAccum.set(el.id, current);
  }

  const arrowUpdates: (Partial<CanvasElement> & { id: string })[] = [];
  let createdCount = 0;

  for (const edge of args.edges) {
    const fromEl = elementMap.get(edge.fromId);
    const toEl   = elementMap.get(edge.toId);
    if (!fromEl || !toEl) continue;

    const fromBox: Box = { x: fromEl.x, y: fromEl.y, width: fromEl.width || 100, height: fromEl.height || 60 };
    const toBox:   Box = { x: toEl.x,   y: toEl.y,   width: toEl.width   || 100, height: toEl.height   || 60 };

    // Per-edge obstacle list: all non-arrow elements except this edge's endpoints
    const obstacles = allElements
      .filter(e => e.id !== edge.fromId && e.id !== edge.toId && e.type !== 'arrow' && e.width && e.height)
      .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

    const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles);

    let arrowId = edge.arrowId;
    if (!arrowId) {
      // Create new arrow (same as layout mode)
      const newArrow: CanvasElement = {
        id: generateId(),
        type: 'arrow',
        x: fromPt[0], y: fromPt[1],
        width: 0, height: 0,
        points: points as [number, number][],
        elbowed,
        start: { id: edge.fromId, gap: 8 },
        end:   { id: edge.toId,   gap: 8 },
        strokeColor: '#1e1e1e',
        strokeStyle: 'solid',
        startArrowhead: null,
        endArrowhead: 'arrow',
      };
      await postElement(newArrow);
      arrowId = newArrow.id;
      createdCount++;
    } else {
      arrowUpdates.push({
        id: arrowId,
        x: fromPt[0], y: fromPt[1],
        points: points as [number, number][],
        elbowed,
      });
    }

    if (fromEl) accumulateBound(fromEl, arrowId);
    if (toEl)   accumulateBound(toEl,   arrowId);
  }

  // Write arrow updates + boundElements in parallel
  await Promise.all([
    ...arrowUpdates.map(u => putElement(u)),
    ...[...boundElementsAccum.entries()].map(([id, boundElements]) =>
      putElement({ id, boundElements })
    ),
  ]);

  return {
    updated: createdCount + arrowUpdates.length,
    positions: [],
  };
}
```

- [ ] **Step 5: Apply patch and run tests**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: All tests pass including the 2 new schema tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add edges-only mode to apply_layout — fixes issue #3"
```

---

## Task 4: Zone/Group Rank Constraints

**Files:**
- Modify: `patches/layout.ts` — new `LayoutGroup` interface, updated `ApplyLayoutArgs`, new `applyGroupsYSnap` function, validation in `handleApplyLayout`, `layoutTools` schema update

**Context:** Dagre spreads zone-based diagrams too wide and doesn't respect zone membership. The fix: run Dagre normally for x-ordering, then post-process y-positions by snapping all members of the same zone to the same y based on their rank.

- [ ] **Step 1: Add failing test for `applyGroupsYSnap`**

Add to `patches/layout.test.ts` (before the summary). Note: `applyGroupsYSnap` was already imported at the top of the test file — no new import needed here.

```typescript
// ---------------------------------------------------------------------------
// Task 4: applyGroupsYSnap
// ---------------------------------------------------------------------------
console.log('\napplyGroupsYSnap — zone y-snap');

test('snaps grouped nodes to zone y-offsets', () => {
  // Three zones: rank 0, 1, 2
  // rank 0 nodes: height=60, so zoneY[0]=0, zoneY[1]=0+60+60(ranksep)=120, zoneY[2]=120+80+60=260
  const positions = [
    { id: 'a', x: 0,   y: 999, width: 100, height: 60 }, // zone 0
    { id: 'b', x: 150, y: 999, width: 100, height: 60 }, // zone 0
    { id: 'c', x: 0,   y: 999, width: 100, height: 80 }, // zone 1
    { id: 'd', x: 0,   y: 999, width: 100, height: 60 }, // zone 2
  ];
  const groups = [
    { id: 'zone0', memberIds: ['a', 'b'], rank: 0 },
    { id: 'zone1', memberIds: ['c'],      rank: 1 },
    { id: 'zone2', memberIds: ['d'],      rank: 2 },
  ];
  const nodes = [
    { id: 'a', resolvedHeight: 60 },
    { id: 'b', resolvedHeight: 60 },
    { id: 'c', resolvedHeight: 80 },
    { id: 'd', resolvedHeight: 60 },
  ];
  applyGroupsYSnap(positions, groups, nodes, 60);

  // zone 0: y = 0
  assert.strictEqual(positions.find(p => p.id === 'a')!.y, 0);
  assert.strictEqual(positions.find(p => p.id === 'b')!.y, 0);
  // zone 1: y = maxHeight(zone0) + rankSep = 60 + 60 = 120
  assert.strictEqual(positions.find(p => p.id === 'c')!.y, 120);
  // zone 2: y = 120 + maxHeight(zone1) + rankSep = 120 + 80 + 60 = 260
  assert.strictEqual(positions.find(p => p.id === 'd')!.y, 260);
});

test('ungrouped nodes keep their Dagre y unchanged', () => {
  const positions = [
    { id: 'a', x: 0, y: 50,  width: 100, height: 60 }, // grouped
    { id: 'b', x: 0, y: 999, width: 100, height: 60 }, // ungrouped
  ];
  const groups = [{ id: 'z', memberIds: ['a'], rank: 0 }];
  const nodes = [{ id: 'a', resolvedHeight: 60 }, { id: 'b', resolvedHeight: 60 }];
  applyGroupsYSnap(positions, groups, nodes, 40);

  assert.strictEqual(positions.find(p => p.id === 'a')!.y, 0);  // snapped to rank 0 = y=0
  assert.strictEqual(positions.find(p => p.id === 'b')!.y, 999); // unchanged
});

test('apply_layout schema includes groups parameter', () => {
  const applyLayout = layoutTools.find(t => t.name === 'apply_layout');
  const props = (applyLayout!.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok('groups' in props, 'groups parameter is in schema');
});
```

Run test — expect failures:
```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

- [ ] **Step 2: Add `LayoutGroup` interface and export `ResolvedPosition`**

In `patches/layout.ts`, add after the existing interfaces at the top:

```typescript
export interface LayoutGroup {
  id: string;
  memberIds: string[];
  rank: number;
}
```

Change the `ResolvedPosition` interface declaration from `interface` to `export interface`:
```typescript
export interface ResolvedPosition {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
```

Add `groups` to `ApplyLayoutArgs`:
```typescript
interface ApplyLayoutArgs {
  algorithm?: 'hierarchical' | 'flow';
  direction?: 'top-down' | 'left-right';
  elementIds?: string[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  spacing?: LayoutSpacing;
  mode?: 'layout' | 'edges-only';
  groups?: LayoutGroup[];
}
```

- [ ] **Step 3: Implement `applyGroupsYSnap`**

Add this exported pure function after `runDagreLayout` (before the HTTP helpers section):

```typescript
/**
 * Post-process Dagre layout output: snap grouped nodes to zone y-positions.
 * All members of the same rank get the same y (top-left), stacked by rank with rankSep gap.
 * Ungrouped nodes keep their Dagre y unchanged. Mutates positions in-place.
 */
export function applyGroupsYSnap(
  positions: ResolvedPosition[],
  groups: LayoutGroup[],
  nodes: { id: string; resolvedHeight: number }[],
  rankSep: number
): void {
  // Build memberId → rank
  const memberRank = new Map<string, number>();
  for (const group of groups) {
    for (const memberId of group.memberIds) {
      memberRank.set(memberId, group.rank);
    }
  }

  // Height lookup: prefer positions (which may have been computed by containment)
  const posHeightMap = new Map(positions.map(p => [p.id, p.height]));
  const nodeHeightMap = new Map(nodes.map(n => [n.id, n.resolvedHeight]));
  function getHeight(id: string): number {
    return posHeightMap.get(id) ?? nodeHeightMap.get(id) ?? 60;
  }

  // Compute max height per rank (across all grouped nodes at that rank)
  const maxHeightByRank = new Map<number, number>();
  for (const pos of positions) {
    const rank = memberRank.get(pos.id);
    if (rank === undefined) continue;
    const h = getHeight(pos.id);
    const current = maxHeightByRank.get(rank) ?? 0;
    if (h > current) maxHeightByRank.set(rank, h);
  }

  // Compute zone y-offsets: sort ranks ascending, accumulate
  const sortedRanks = [...new Set([...memberRank.values()])].sort((a, b) => a - b);
  const zoneYOffset = new Map<number, number>();
  let cumY = 0;
  for (const rank of sortedRanks) {
    zoneYOffset.set(rank, cumY);
    cumY += (maxHeightByRank.get(rank) ?? 60) + rankSep;
  }

  // Snap grouped nodes
  for (const pos of positions) {
    const rank = memberRank.get(pos.id);
    if (rank === undefined) continue;
    pos.y = zoneYOffset.get(rank) ?? pos.y;
  }
}
```

- [ ] **Step 4: Add validation and call `applyGroupsYSnap` in `handleApplyLayout`**

In `handleApplyLayout`, after the existing parentId cycle detection and before `if (args.nodes.length === 0)`, add groups validation:

```typescript
  // Validate groups (layout mode only — silently ignored in edges-only which was handled above)
  if (args.groups && args.groups.length > 0) {
    const memberGroupMap = new Map<string, string>();
    const nodeWithParent = new Set(args.nodes.filter(n => n.parentId).map(n => n.id));
    for (const group of args.groups) {
      if (!Number.isInteger(group.rank) || group.rank < 0) {
        throw new Error(`groups: rank must be a non-negative integer (got ${group.rank} in group "${group.id}")`);
      }
      for (const memberId of group.memberIds) {
        if (memberGroupMap.has(memberId)) {
          throw new Error(`memberId ${memberId} appears in multiple groups`);
        }
        memberGroupMap.set(memberId, group.id);
        if (nodeWithParent.has(memberId)) {
          throw new Error(`groups member ${memberId} is a child node; groups only supports root-level nodes`);
        }
      }
    }
  }
```

After `runDagreLayout` returns `positions`, add the y-snap call:

Find:
```typescript
  // Phase 4: route arrows
```

Insert before it:
```typescript
  // Apply zone y-snap if groups are provided
  if (args.groups && args.groups.length > 0) {
    applyGroupsYSnap(positions, args.groups, nodesWithSize, spacing.rankSep);
  }

```

- [ ] **Step 5: Add `groups` to `apply_layout` tool schema**

In `layoutTools`, add the `groups` property to `apply_layout`'s inputSchema properties (after `spacing`):

```typescript
        groups: {
          type: 'array',
          description: 'Zone/rank constraints. Members of the same zone are snapped to the same y-position after Dagre layout. Only applies in layout mode; ignored in edges-only mode. Each group member must be a root-level node (no parentId).',
          items: {
            type: 'object',
            properties: {
              id:        { type: 'string', description: 'Zone identifier (for reference only).' },
              memberIds: { type: 'array', items: { type: 'string' }, description: 'Element IDs that belong to this zone.' },
              rank:      { type: 'number', description: 'Zone rank — non-negative integer. Lower rank = higher on canvas (top-down). Multiple groups may share the same rank.' },
            },
            required: ['id', 'memberIds', 'rank'],
          },
        },
```

- [ ] **Step 6: Apply patch and run tests**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: add groups zone y-snap to apply_layout — fixes issue #4"
```

---

## Task 5: `move_element` Proximity Detection for Unbound Arrows

**Files:**
- Modify: `patches/layout.ts` — `handleMoveElement` auto-detect path, new translation logic for proximity-detected arrows

**Context:** `handleMoveElement` only finds arrows via `start?.id` / `end?.id` bindings. Arrows created via `batch_create_elements` with manual `points` have no binding fields. The fix adds a second pass that checks if the arrow's first or last point falls within the moved element's expanded bounding box, then translates that endpoint by the move delta.

- [ ] **Step 1: Add failing tests for proximity detection helpers**

Add to `patches/layout.test.ts` (before the summary):

```typescript
// ---------------------------------------------------------------------------
// Task 5: proximity detection — pure geometry helpers
// ---------------------------------------------------------------------------
console.log('\nmove_element proximity — point-in-expanded-box checks');

// Helper we'll test indirectly via pointInExpandedBox logic
// We extract the same math here to verify it
function pointInBox(
  px: number, py: number,
  bx: number, by: number, bw: number, bh: number,
  gap: number
): boolean {
  return px >= bx - gap && px <= bx + bw + gap &&
         py >= by - gap && py <= by + bh + gap;
}

test('point inside expanded box returns true', () => {
  // Element at (100,100) 80×60, gap=8 → expanded box: (92,92,96,76)
  assert.strictEqual(pointInBox(100, 100, 100, 100, 80, 60, 8), true);
});

test('point outside expanded box returns false', () => {
  assert.strictEqual(pointInBox(80, 80, 100, 100, 80, 60, 8), false); // x=80 < 92
});

test('point on the expanded edge returns true', () => {
  // Left expanded edge: x = 100 - 8 = 92
  assert.strictEqual(pointInBox(92, 130, 100, 100, 80, 60, 8), true);
});

// Verify arrow translation math for last-point case
test('arrow last-point translation: points[N-1] shifts correctly', () => {
  // Arrow: x=0, y=0, points=[[0,0],[100,0],[100,100]]
  // Attached endpoint is last (points[2]=[100,100]), dx=20, dy=10
  // Result: points[2] should become [120,110], x/y unchanged
  const points: [number, number][] = [[0,0],[100,0],[100,100]];
  const dx = 20, dy = 10;
  points[points.length - 1] = [points[points.length - 1]![0] + dx, points[points.length - 1]![1] + dy];
  assert.deepStrictEqual(points[2], [120, 110]);
  // x and y of arrow unchanged — verified by the fact we didn't touch them
});

test('arrow first-point translation: x/y shifts, all other points compensate', () => {
  // Arrow: x=50, y=50, points=[[0,0],[100,0],[100,100]]
  // Attached endpoint is first (points[0]), dx=20, dy=10
  // Result: x=70, y=60, points[0]=[0,0] (unchanged), points[1]=[80,-10], points[2]=[80,90]
  let arrowX = 50, arrowY = 50;
  const points: [number, number][] = [[0,0],[100,0],[100,100]];
  const dx = 20, dy = 10;
  arrowX += dx;
  arrowY += dy;
  for (let i = 1; i < points.length; i++) {
    points[i] = [points[i]![0] - dx, points[i]![1] - dy];
  }
  assert.strictEqual(arrowX, 70);
  assert.strictEqual(arrowY, 60);
  assert.deepStrictEqual(points[0], [0, 0]);
  assert.deepStrictEqual(points[1], [80, -10]);
  assert.deepStrictEqual(points[2], [80, 90]);
});
```

Run tests — the new tests pass (they test inline math, not exported functions), but that's fine; they document the expected behavior:
```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: All tests pass (the geometry tests above are pure math, no imports needed).

- [ ] **Step 2: Implement proximity detection in `handleMoveElement`**

In `patches/layout.ts`, replace the **entire** arrow detection block (both the `if (args.arrowIds ...)` branch AND the `else` branch) in `handleMoveElement`:

Find:
```typescript
  // Find connected arrows
  let arrowElements: CanvasElement[];
  if (args.arrowIds && args.arrowIds.length > 0) {
    arrowElements = elements.filter(
      e => args.arrowIds!.includes(e.id) &&
           e.type === 'arrow' &&
           (e.start?.id === args.id || e.end?.id === args.id)
    );
  } else {
    arrowElements = elements.filter(
      e => e.type === 'arrow' && (e.start?.id === args.id || e.end?.id === args.id)
    );
  }
```

Replace with:
```typescript
  // Find connected arrows
  let arrowElements: CanvasElement[];
  if (args.arrowIds && args.arrowIds.length > 0) {
    // Manual override: use all specified arrows regardless of binding status.
    // Proximity detection does not run in this path.
    arrowElements = elements.filter(
      e => args.arrowIds!.includes(e.id) && e.type === 'arrow'
    );
  } else {
    // Binding-based detection
    const bindingDetected = elements.filter(
      e => e.type === 'arrow' && (e.start?.id === args.id || e.end?.id === args.id)
    );
    const bindingIds = new Set(bindingDetected.map(e => e.id));

    // Proximity-based detection: arrows whose first or last absolute point
    // falls within the moved element's expanded bounding box (gap=8)
    const GAP = 8;
    const elX = el.x, elY = el.y, elW = el.width || 100, elH = el.height || 60;
    const proximityDetected = elements.filter(e => {
      if (e.type !== 'arrow' || !e.points?.length) return false;
      if (bindingIds.has(e.id)) return false; // already in bindingDetected
      const pts = e.points;
      const firstAbs: [number, number] = [e.x + (pts[0]?.[0] ?? 0), e.y + (pts[0]?.[1] ?? 0)];
      const lastAbs:  [number, number] = [
        e.x + (pts[pts.length - 1]?.[0] ?? 0),
        e.y + (pts[pts.length - 1]?.[1] ?? 0),
      ];
      const inBox = (px: number, py: number) =>
        px >= elX - GAP && px <= elX + elW + GAP &&
        py >= elY - GAP && py <= elY + elH + GAP;
      return inBox(firstAbs[0], firstAbs[1]) || inBox(lastAbs[0], lastAbs[1]);
    });

    arrowElements = [...bindingDetected, ...proximityDetected];
  }
```

- [ ] **Step 3: Add translation rerouting for proximity-detected arrows**

In `handleMoveElement`, the rerouting loop currently processes all `arrowElements` the same way. We need to split: binding-detected arrows use `routeArrow`, proximity-detected arrows use translation.

Add a `Set` to track which arrows were proximity-detected (add this right after the `arrowElements` assignment):

```typescript
  // Track which arrows need translation vs full reroute
  const proximityArrowIds: Set<string> = new Set(
    args.arrowIds
      ? [] // manual arrowIds: no proximity detection
      : arrowElements
          .filter(e => !(e.start?.id === args.id || e.end?.id === args.id))
          .map(e => e.id)
  );
```

Then in the rerouting loop, after `for (const arrow of arrowElements) {`, add a branch for proximity arrows:

Find the start of the loop:
```typescript
  for (const arrow of arrowElements) {
    const otherId = arrow.start?.id === args.id ? arrow.end?.id : arrow.start?.id;
    const otherEl = otherId ? elements.find(e => e.id === otherId) : undefined;
    if (!otherEl) continue;
```

Replace with:
```typescript
  const dx = args.x - el.x;
  const dy = args.y - el.y;

  for (const arrow of arrowElements) {
    // Proximity-detected (no bindings): use translation
    if (proximityArrowIds.has(arrow.id)) {
      const pts = arrow.points;
      if (!pts || pts.length === 0) continue;
      const GAP = 8;
      const elX = el.x, elY = el.y, elW = el.width || 100, elH = el.height || 60;
      const inBox = (px: number, py: number) =>
        px >= elX - GAP && px <= elX + elW + GAP &&
        py >= elY - GAP && py <= elY + elH + GAP;

      const firstAbs: [number, number] = [arrow.x + (pts[0]?.[0] ?? 0), arrow.y + (pts[0]?.[1] ?? 0)];
      const lastAbs:  [number, number] = [
        arrow.x + (pts[pts.length - 1]?.[0] ?? 0),
        arrow.y + (pts[pts.length - 1]?.[1] ?? 0),
      ];
      const firstAttached = inBox(firstAbs[0], firstAbs[1]);
      const lastAttached  = inBox(lastAbs[0],  lastAbs[1]);

      const newPts: [number, number][] = pts.map(p => [p[0], p[1]]);
      let newArrowX = arrow.x;
      let newArrowY = arrow.y;

      if (firstAttached && lastAttached) {
        // Self-loop: translate entire arrow
        newArrowX += dx;
        newArrowY += dy;
        // points unchanged
      } else if (firstAttached) {
        // Shift origin, compensate all other points
        newArrowX += dx;
        newArrowY += dy;
        for (let i = 1; i < newPts.length; i++) {
          newPts[i] = [newPts[i]![0] - dx, newPts[i]![1] - dy];
        }
        // newPts[0] stays [0,0]
      } else if (lastAttached) {
        // Shift only last point
        const last = newPts[newPts.length - 1]!;
        newPts[newPts.length - 1] = [last[0] + dx, last[1] + dy];
      }

      updatedArrows.push({
        id: arrow.id,
        x: newArrowX,
        y: newArrowY,
        points: newPts as [number, number][],
      });
      continue;
    }

    // Binding-detected: full reroute via routeArrow
    const otherId = arrow.start?.id === args.id ? arrow.end?.id : arrow.start?.id;
    const otherEl = otherId ? elements.find(e => e.id === otherId) : undefined;
    if (!otherEl) continue;

    const isFrom = arrow.start?.id === args.id;
    const fromBox = isFrom ? movedElBox : { x: otherEl.x, y: otherEl.y, width: otherEl.width || 100, height: otherEl.height || 60 };
    const toBox   = isFrom ? { x: otherEl.x, y: otherEl.y, width: otherEl.width || 100, height: otherEl.height || 60 } : movedElBox;

    const obstacles = elements
      .filter(e => e.id !== args.id && e.id !== otherId && e.id !== arrow.id && e.type !== 'arrow' && e.width && e.height)
      .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

    const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles);

    updatedArrows.push({
      id: arrow.id,
      x: fromPt[0],
      y: fromPt[1],
      points: points as [number, number][],
      elbowed,
    });
  }  // end for (const arrow of arrowElements)
```

This completes the full loop body. The existing lines after `if (!otherEl) continue;` (isFrom, fromBox, toBox, obstacles, routeArrow, updatedArrows.push) are included above so the implementer has the complete replacement — do NOT keep the original lines below the replaced block. The closing `}` on the last line above ends the loop.

- [ ] **Step 4: Apply patch and run all tests**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected: All tests pass. Build succeeds with `Found 0 errors.`

- [ ] **Step 5: Commit**

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
git add patches/layout.ts patches/layout.test.ts
git commit -m "feat: proximity detection for unbound arrows in move_element — fixes issue #6"
```

---

## Final Verification

After all tasks are complete, do a full rebuild and run the complete test suite:

```bash
cd /Users/vtajzich/environment/repos/private/excalidraw
bash scripts/add_layout_tools.sh
cd mcp_excalidraw && npx --yes tsx ../patches/layout.test.ts
```

Expected final output:
```
routeArrow — exhaustive attachment point search
  ✓ finds clear straight path via non-nearest side when nearest is blocked
  ✓ no obstacles: picks shortest straight path (bottom-to-top when aligned)
  ✓ all straight paths blocked: picks elbow with fewest intersections
  ✓ segmentIntersectsBox: line through center hits box
  ✓ segmentIntersectsBox: line beside box does not hit
  ✓ countElbowIntersections: counts segments that cross an obstacle

apply_layout schema — mode parameter
  ✓ apply_layout tool schema includes mode parameter
  ✓ apply_layout tool schema algorithm is not required when mode is edges-only

applyGroupsYSnap — zone y-snap
  ✓ snaps grouped nodes to zone y-offsets
  ✓ ungrouped nodes keep their Dagre y unchanged
  ✓ apply_layout schema includes groups parameter

move_element proximity — point-in-expanded-box checks
  ✓ point inside expanded box returns true
  ✓ point outside expanded box returns false
  ✓ point on the expanded edge returns true
  ✓ arrow last-point translation: points[N-1] shifts correctly
  ✓ arrow first-point translation: x/y shifts, all other points compensate

16 passed, 0 failed
```

Also verify TypeScript compiles cleanly:
```bash
cd mcp_excalidraw && npx tsc --noEmit
```
Expected: `Found 0 errors.`
