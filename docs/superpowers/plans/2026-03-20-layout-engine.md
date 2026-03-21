# Layout Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three MCP tools (`apply_layout`, `move_element`, `create_arrow`) to the Excalidraw MCP server via a patch that arranges elements using Dagre, handles parent-child containment, and routes arrows.

**Architecture:** All code lives in `patches/layout.ts` (copied to `mcp_excalidraw/src/layout.ts` at patch time). `patches/patch-index-layout.mjs` injects the tools into `src/index.ts` using the same idempotent `str.replace` pattern as the existing library tools patch. `src/server.ts` is never touched.

**Tech Stack:** TypeScript, dagre (`npm install dagre @types/dagre` inside `mcp_excalidraw/`), node-fetch (already a dependency), `@modelcontextprotocol/sdk/types.js` (already present).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `patches/layout.ts` | Create | Layout engine + all three tool definitions and handlers |
| `patches/patch-index-layout.mjs` | Create | Idempotent patcher for `src/index.ts` |
| `patches/test-layout-unit.mjs` | Create | Unit tests for pure functions (no HTTP, no canvas) |
| `scripts/add_layout_tools.sh` | Create | Install dagre + apply patch + rebuild |
| `scripts/init_full.sh` | Modify | Add step 5: call `add_layout_tools.sh` |
| `.claude/commands/add-layout-tools.md` | Create | Claude Code slash command |
| `.cursor/commands/add-layout-tools.md` | Create | Cursor command |

---

## Background: Key Codebase Facts

Before implementing, understand these facts about `mcp_excalidraw`:

- **HTTP pattern:** `index.ts` calls `syncToCanvas('update', data)` which does `PUT /api/elements/:id`. Use `fetch` directly in `layout.ts` since `syncToCanvas` is not exported. Read `EXPRESS_SERVER_URL` from `process.env.EXPRESS_SERVER_URL || 'http://localhost:3000'`.
- **Arrow storage:** Arrows store `start: { id: string }` and `end: { id: string }` in the Express element map (not `startBinding`/`endBinding`). Scan for `el.start?.id` and `el.end?.id` when looking for connected arrows.
- **Arrow points:** Stored relative to arrow's own `x,y`. `arrow.x = startPoint.x`, `arrow.y = startPoint.y`, `arrow.points = [[0,0], ..., [endX - startX, endY - startY]]`.
- **Dagre coordinates:** Dagre returns **center** coordinates. Convert to top-left: `topLeftX = dagreNode.x - width/2`, `topLeftY = dagreNode.y - height/2`.
- **After library patch:** `src/index.ts` already contains `import { libraryTools, handleLibraryTool } from './library-tools.js';` and `tools.push(...libraryTools);` — the layout patcher anchors on these exact strings.
- **Async handlers:** The outer `server.setRequestHandler` callback is already `async`. Layout tool cases use `await handleLayoutTool(...)`.
- **generateId:** Imported from `./types.js` in `index.ts`. In `layout.ts`, generate IDs with: `Math.random().toString(36).slice(2, 11)` (same length as existing IDs).
- **Error handling:** Throw `new Error(message)` — the outer try/catch in `index.ts` catches it and returns MCP error format.

---

## Task 1: Pure Geometry Functions

**Files:**
- Create: `patches/test-layout-unit.mjs` (write tests first)
- Create: `patches/layout.ts` (geometry section only)

These functions have zero dependencies — no HTTP, no Dagre, no canvas. Test them in isolation.

- [ ] **Step 1.1: Create the test file**

```javascript
// patches/test-layout-unit.mjs
// Run with: node patches/test-layout-unit.mjs

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// ---- Import functions under test ----
// We'll inline them here for now, then replace with imports after layout.ts exists.

function segmentIntersectsBox(p1, p2, box) {
  // TODO: implement
}

function getSideMidpoints(el) {
  // TODO: implement
}

function nearestMidpointPair(from, to) {
  // TODO: implement
}

function countElbowIntersections(waypoints, obstacles) {
  // TODO: implement
}

// ---- Tests ----

console.log('\n=== segmentIntersectsBox ===');
const box = { x: 100, y: 100, width: 100, height: 100 }; // box: 100-200 x 100-200

assert(
  segmentIntersectsBox([50, 150], [250, 150], box) === true,
  'horizontal line crossing box returns true'
);
assert(
  segmentIntersectsBox([50, 50], [80, 80], box) === false,
  'line not touching box returns false'
);
assert(
  segmentIntersectsBox([150, 50], [150, 250], box) === true,
  'vertical line crossing box returns true'
);
assert(
  segmentIntersectsBox([120, 120], [180, 180], box) === false,
  'line entirely inside box returns false (source/target exclusion handled by caller)'
);

console.log('\n=== getSideMidpoints ===');
const el = { x: 100, y: 100, width: 200, height: 100 };
const pts = getSideMidpoints(el);
assert(pts.top[0] === 200 && pts.top[1] === 100, 'top midpoint correct');
assert(pts.bottom[0] === 200 && pts.bottom[1] === 200, 'bottom midpoint correct');
assert(pts.left[0] === 100 && pts.left[1] === 150, 'left midpoint correct');
assert(pts.right[0] === 300 && pts.right[1] === 150, 'right midpoint correct');

console.log('\n=== nearestMidpointPair ===');
const fromEl = { x: 0, y: 0, width: 100, height: 100 };    // center 50,50
const toEl   = { x: 200, y: 0, width: 100, height: 100 };   // center 250,50
const pair = nearestMidpointPair(fromEl, toEl);
assert(pair.fromPt[0] === 100 && pair.fromPt[1] === 50, 'nearest from-point is right midpoint');
assert(pair.toPt[0]   === 200 && pair.toPt[1]   === 50, 'nearest to-point is left midpoint');

console.log('\n=== countElbowIntersections ===');
const obstacle = { x: 150, y: 0, width: 50, height: 200 };
// Horizontal-first elbow: [0,50] -> [200,50] -> [250,50] — first segment crosses obstacle
const elbowA = [[0,50],[200,50],[250,50]];
// Vertical-first elbow: [0,50] -> [0,150] -> [250,50] — goes around
const elbowB = [[0,50],[0,150],[250,50]]; // second segment crosses obstacle too
assert(countElbowIntersections(elbowA, [obstacle]) >= 1, 'blocked elbow has intersections');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 1.2: Run test file — expect failures (functions return undefined)**

```bash
node patches/test-layout-unit.mjs
```
Expected: errors about undefined returns or assertion failures.

- [ ] **Step 1.3: Create `patches/layout.ts` with geometry functions**

```typescript
// patches/layout.ts
// Layout engine for Excalidraw MCP — patch file.
// Copied to mcp_excalidraw/src/layout.ts by add_layout_tools.sh

import fetch from 'node-fetch';
import dagre from 'dagre';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayoutNode {
  id: string;
  parentId?: string;
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
  arrowId?: string;
}

export interface LayoutSpacing {
  nodeSep?: number;
  rankSep?: number;
  padding?: number;
}

interface CanvasElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  start?: { id: string; gap?: number };
  end?: { id: string; gap?: number };
  boundElements?: { type: string; id: string }[];
  points?: [number, number][];
  strokeColor?: string;
  strokeStyle?: string;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  [key: string]: unknown;
}

type Point = [number, number];
type Box = { x: number; y: number; width: number; height: number };
type SideMidpoints = { top: Point; bottom: Point; left: Point; right: Point };

// ---------------------------------------------------------------------------
// Geometry — pure functions, no I/O
// ---------------------------------------------------------------------------

export function getSideMidpoints(el: Box): SideMidpoints {
  return {
    top:    [el.x + el.width / 2,  el.y],
    bottom: [el.x + el.width / 2,  el.y + el.height],
    left:   [el.x,                 el.y + el.height / 2],
    right:  [el.x + el.width,      el.y + el.height / 2],
  };
}

/**
 * Returns true if segment p1→p2 crosses the boundary of box.
 * Does NOT return true if segment is entirely inside — callers exclude
 * source and target elements before calling this.
 */
export function segmentIntersectsBox(p1: Point, p2: Point, box: Box): boolean {
  // Check if segment crosses any of the 4 box edges
  const edges: [Point, Point][] = [
    [[box.x, box.y],                    [box.x + box.width, box.y]],           // top
    [[box.x + box.width, box.y],        [box.x + box.width, box.y + box.height]], // right
    [[box.x, box.y + box.height],       [box.x + box.width, box.y + box.height]], // bottom
    [[box.x, box.y],                    [box.x, box.y + box.height]],           // left
  ];
  return edges.some(([a, b]) => segmentsIntersect(p1, p2, a, b));
}

function cross2d(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross2d(p3, p4, p1);
  const d2 = cross2d(p3, p4, p2);
  const d3 = cross2d(p1, p2, p3);
  const d4 = cross2d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

export function nearestMidpointPair(
  from: Box,
  to: Box
): { fromPt: Point; toPt: Point } {
  const fromPts = getSideMidpoints(from);
  const toPts = getSideMidpoints(to);
  let best = { fromPt: fromPts.right, toPt: toPts.left, dist: Infinity };
  for (const fk of Object.keys(fromPts) as (keyof SideMidpoints)[]) {
    for (const tk of Object.keys(toPts) as (keyof SideMidpoints)[]) {
      const fp = fromPts[fk];
      const tp = toPts[tk];
      const dist = Math.hypot(fp[0] - tp[0], fp[1] - tp[1]);
      if (dist < best.dist) best = { fromPt: fp, toPt: tp, dist };
    }
  }
  return { fromPt: best.fromPt, toPt: best.toPt };
}

export function countElbowIntersections(waypoints: Point[], obstacles: Box[]): number {
  let count = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    for (const box of obstacles) {
      if (segmentIntersectsBox(waypoints[i], waypoints[i + 1], box)) count++;
    }
  }
  return count;
}

/**
 * Route an arrow between two elements. Returns relative points[] and elbowed flag.
 * obstacles: all canvas elements except from and to.
 */
export function routeArrow(
  from: Box,
  to: Box,
  obstacles: Box[]
): { points: Point[]; elbowed: boolean } {
  const { fromPt, toPt } = nearestMidpointPair(from, to);

  // Try straight line
  const straightBlocked = obstacles.some(obs => segmentIntersectsBox(fromPt, toPt, obs));

  if (!straightBlocked) {
    // Relative to fromPt
    return {
      points: [[0, 0], [toPt[0] - fromPt[0], toPt[1] - fromPt[1]]],
      elbowed: false,
    };
  }

  // Elbow candidates
  const mid1: Point = [toPt[0], fromPt[1]]; // horizontal-first midpoint
  const mid2: Point = [fromPt[0], toPt[1]]; // vertical-first midpoint

  const candidateA: Point[] = [fromPt, mid1, toPt];
  const candidateB: Point[] = [fromPt, mid2, toPt];

  const countA = countElbowIntersections(candidateA, obstacles);
  const countB = countElbowIntersections(candidateB, obstacles);

  // Pick fewer intersections; tiebreak: prefer horizontal-first (A);
  // secondary tiebreak: shorter path length
  let chosen = candidateA;
  if (countB < countA) {
    chosen = candidateB;
  } else if (countB === countA) {
    const lenA = Math.hypot(mid1[0]-fromPt[0], mid1[1]-fromPt[1]) + Math.hypot(toPt[0]-mid1[0], toPt[1]-mid1[1]);
    const lenB = Math.hypot(mid2[0]-fromPt[0], mid2[1]-fromPt[1]) + Math.hypot(toPt[0]-mid2[0], toPt[1]-mid2[1]);
    if (lenB < lenA) chosen = candidateB;
  }

  // Convert to relative coordinates
  const origin = chosen[0];
  return {
    points: chosen.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
  };
}
```

- [ ] **Step 1.4: Update test file to import from layout.ts via compiled JS**

The test file needs to run against compiled JS. For now, duplicate the functions inline in the test (they're pure). Update the test to use the inline implementations:

```javascript
// Replace the TODO stubs in patches/test-layout-unit.mjs with the actual implementations
// copied from patches/layout.ts (the pure functions only — no imports needed)

function cross2d(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross2d(p3, p4, p1), d2 = cross2d(p3, p4, p2);
  const d3 = cross2d(p1, p2, p3), d4 = cross2d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segmentIntersectsBox(p1, p2, box) {
  const edges = [
    [[box.x, box.y], [box.x + box.width, box.y]],
    [[box.x + box.width, box.y], [box.x + box.width, box.y + box.height]],
    [[box.x, box.y + box.height], [box.x + box.width, box.y + box.height]],
    [[box.x, box.y], [box.x, box.y + box.height]],
  ];
  return edges.some(([a, b]) => segmentsIntersect(p1, p2, a, b));
}
function getSideMidpoints(el) {
  return {
    top:    [el.x + el.width / 2,  el.y],
    bottom: [el.x + el.width / 2,  el.y + el.height],
    left:   [el.x,                 el.y + el.height / 2],
    right:  [el.x + el.width,      el.y + el.height / 2],
  };
}
function nearestMidpointPair(from, to) {
  const fromPts = getSideMidpoints(from), toPts = getSideMidpoints(to);
  let best = { fromPt: fromPts.right, toPt: toPts.left, dist: Infinity };
  for (const fk of Object.keys(fromPts)) {
    for (const tk of Object.keys(toPts)) {
      const fp = fromPts[fk], tp = toPts[tk];
      const dist = Math.hypot(fp[0]-tp[0], fp[1]-tp[1]);
      if (dist < best.dist) best = { fromPt: fp, toPt: tp, dist };
    }
  }
  return { fromPt: best.fromPt, toPt: best.toPt };
}
function countElbowIntersections(waypoints, obstacles) {
  let count = 0;
  for (let i = 0; i < waypoints.length - 1; i++)
    for (const box of obstacles)
      if (segmentIntersectsBox(waypoints[i], waypoints[i+1], box)) count++;
  return count;
}
```

- [ ] **Step 1.5: Run tests — expect all pass**

```bash
node patches/test-layout-unit.mjs
```
Expected output: all `✓`, `0 failed`.

- [ ] **Step 1.6: Commit**

```bash
git add patches/layout.ts patches/test-layout-unit.mjs
git commit -m "feat: add layout engine geometry functions with unit tests"
```

---

## Task 2: Cycle Detection + Dagre Adapter + Containment Resolver

**Files:**
- Modify: `patches/layout.ts` — add cycle detection, Dagre adapter, containment resolver
- Modify: `patches/test-layout-unit.mjs` — add tests for cycle detection and containment

- [ ] **Step 2.1: Add cycle detection tests to test file**

Append to `patches/test-layout-unit.mjs`:

```javascript
// ---- Cycle detection ----
function detectCycle(nodes, edges) {
  // TODO — stub
}

console.log('\n=== detectCycle ===');
const nodesA = [{id:'a'},{id:'b'},{id:'c'}];
assert(detectCycle(nodesA, [{fromId:'a',toId:'b'},{fromId:'b',toId:'c'}]) === null, 'DAG returns null');
assert(typeof detectCycle(nodesA, [{fromId:'a',toId:'b'},{fromId:'b',toId:'c'},{fromId:'c',toId:'a'}]) === 'string', 'cycle returns error string');
```

- [ ] **Step 2.2: Run — expect failure on cycle tests**

```bash
node patches/test-layout-unit.mjs
```

- [ ] **Step 2.3: Add cycle detection + Dagre adapter + containment resolver to `patches/layout.ts`**

Append after the geometry section:

```typescript
// ---------------------------------------------------------------------------
// Cycle detection (DFS topological sort)
// ---------------------------------------------------------------------------

export function detectCycle(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): string | null {
  const ids = new Set(nodes.map(n => n.id));
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (ids.has(e.fromId) && ids.has(e.toId)) {
      adj.get(e.fromId)!.push(e.toId);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  function dfs(id: string): string | null {
    color.set(id, GRAY);
    for (const next of adj.get(id) || []) {
      if (color.get(next) === GRAY) return `${id} → ${next}`;
      if (color.get(next) === WHITE) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      }
    }
    color.set(id, BLACK);
    return null;
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) {
      const cycle = dfs(id);
      if (cycle) return `Cycle detected: ${cycle}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dagre adapter — two-pass layout
// ---------------------------------------------------------------------------

interface ResolvedPosition {
  id: string;
  x: number;  // top-left
  y: number;
  width: number;
  height: number;
}

export function runDagreLayout(
  nodes: (LayoutNode & { resolvedWidth: number; resolvedHeight: number })[],
  edges: LayoutEdge[],
  algorithm: 'hierarchical' | 'flow',
  direction: 'top-down' | 'left-right',
  spacing: Required<LayoutSpacing>
): ResolvedPosition[] {
  const rankdir = direction === 'top-down' ? 'TB' : 'LR';
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Group nodes by parentId
  const childrenOf = new Map<string | undefined, string[]>();
  for (const n of nodes) {
    const key = n.parentId;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n.id);
  }

  const relPositions = new Map<string, { x: number; y: number; w: number; h: number }>();

  // Build a node→parentId map for depth calculation
  const nodeParentMap = new Map(nodes.filter(n => n.parentId).map(n => [n.id, n.parentId!]));
  const depthCache = new Map<string, number>();
  function nodeDepth(id: string): number {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const parent = nodeParentMap.get(id);
    const d = parent ? 1 + nodeDepth(parent) : 0;
    depthCache.set(id, d);
    return d;
  }

  // Pass A: layout children within each parent group — deepest first (bottom-up)
  // This ensures grandparent sizes are computed after their children's sizes are known.
  const parentGroups = [...childrenOf.entries()]
    .filter(([key]) => key !== undefined) as [string, string[]][];
  parentGroups.sort(([a], [b]) => nodeDepth(b) - nodeDepth(a)); // deepest parent first

  // computedSizes tracks the final size of each parent (used when the parent is itself a child)
  const computedSizes = new Map<string, { w: number; h: number }>();

  for (const [parentId, childIds] of parentGroups) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir, nodesep: spacing.nodeSep, ranksep: spacing.rankSep });
    g.setDefaultEdgeLabel(() => ({}));

    for (const id of childIds) {
      const n = nodeMap.get(id)!;
      // If this child is itself a parent, use its already-computed size (bottom-up)
      const size = computedSizes.get(id) || { w: n.resolvedWidth, h: n.resolvedHeight };
      g.setNode(id, { width: size.w, height: size.h });
    }
    const childSet = new Set(childIds);
    for (const e of edges) {
      if (childSet.has(e.fromId) && childSet.has(e.toId)) {
        g.setEdge(e.fromId, e.toId);
      }
    }
    dagre.layout(g);
    for (const id of childIds) {
      const { x, y } = g.node(id);
      const size = computedSizes.get(id) || { w: nodeMap.get(id)!.resolvedWidth, h: nodeMap.get(id)!.resolvedHeight };
      // Dagre returns center; convert to top-left
      relPositions.set(id, { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h });
    }

    // Compute this parent's size from its children's bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of childIds) {
      const pos = relPositions.get(id)!;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + pos.w > maxX) maxX = pos.x + pos.w;
      if (pos.y + pos.h > maxY) maxY = pos.y + pos.h;
    }
    computedSizes.set(parentId, {
      w: (maxX - minX) + 2 * spacing.padding,
      h: (maxY - minY) + 2 * spacing.padding,
    });
  }

  // parentSizes is now just computedSizes
  const parentSizes = computedSizes;

  // Pass B: layout root nodes + parents with correct sizes
  const g2 = new dagre.graphlib.Graph();
  g2.setGraph({ rankdir, nodesep: spacing.nodeSep, ranksep: spacing.rankSep });
  g2.setDefaultEdgeLabel(() => ({}));

  const rootIds = childrenOf.get(undefined) || [];
  const parentIds = [...childrenOf.keys()].filter(k => k !== undefined) as string[];

  for (const id of rootIds) {
    const n = nodeMap.get(id)!;
    g2.setNode(id, { width: n.resolvedWidth, height: n.resolvedHeight });
  }
  for (const id of parentIds) {
    const size = parentSizes.get(id) || { w: 100, h: 100 };
    g2.setNode(id, { width: size.w, height: size.h });
  }

  const topLevelIds = new Set([...rootIds, ...parentIds]);
  for (const e of edges) {
    if (topLevelIds.has(e.fromId) && topLevelIds.has(e.toId)) {
      g2.setEdge(e.fromId, e.toId);
    }
  }
  dagre.layout(g2);

  const results: ResolvedPosition[] = [];

  // Root nodes: use Pass B positions directly
  for (const id of rootIds) {
    const { x, y } = g2.node(id);
    const n = nodeMap.get(id)!;
    results.push({ id, x: x - n.resolvedWidth / 2, y: y - n.resolvedHeight / 2, width: n.resolvedWidth, height: n.resolvedHeight });
  }

  // Parents + their children: use Pass B for parent origin, Phase 3 sets final bbox
  for (const id of parentIds) {
    const { x, y } = g2.node(id);
    const size = parentSizes.get(id)!;
    // Parent top-left from Pass B
    const parentOriginX = x - size.w / 2;
    const parentOriginY = y - size.h / 2;

    // Offset children relative to parent + padding
    const childIds = childrenOf.get(id)!;
    let minChildX = Infinity, minChildY = Infinity;
    for (const cid of childIds) {
      const pos = relPositions.get(cid)!;
      if (pos.x < minChildX) minChildX = pos.x;
      if (pos.y < minChildY) minChildY = pos.y;
    }

    for (const cid of childIds) {
      const pos = relPositions.get(cid)!;
      results.push({
        id: cid,
        x: parentOriginX + spacing.padding + (pos.x - minChildX),
        y: parentOriginY + spacing.padding + (pos.y - minChildY),
        width: pos.w,
        height: pos.h,
      });
    }

    // Phase 3: parent bbox from children
    const childResults = results.filter(r => childIds.includes(r.id));
    const pMinX = Math.min(...childResults.map(r => r.x));
    const pMinY = Math.min(...childResults.map(r => r.y));
    const pMaxX = Math.max(...childResults.map(r => r.x + r.width));
    const pMaxY = Math.max(...childResults.map(r => r.y + r.height));
    results.push({
      id,
      x: pMinX - spacing.padding,
      y: pMinY - spacing.padding,
      width: (pMaxX - pMinX) + 2 * spacing.padding,
      height: (pMaxY - pMinY) + 2 * spacing.padding,
    });
  }

  return results;
}
```

- [ ] **Step 2.4: Add inline implementations to test file and run**

Add inline `detectCycle` to `patches/test-layout-unit.mjs` (copy from layout.ts, remove TypeScript annotations):

```javascript
function detectCycle(nodes, edges) {
  const ids = new Set(nodes.map(n => n.id));
  const adj = new Map();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) {
    if (ids.has(e.fromId) && ids.has(e.toId)) adj.get(e.fromId).push(e.toId);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of ids) color.set(id, WHITE);
  function dfs(id) {
    color.set(id, GRAY);
    for (const next of adj.get(id) || []) {
      if (color.get(next) === GRAY) return `${id} → ${next}`;
      if (color.get(next) === WHITE) { const c = dfs(next); if (c) return c; }
    }
    color.set(id, BLACK);
    return null;
  }
  for (const id of ids) {
    if (color.get(id) === WHITE) { const c = dfs(id); if (c) return `Cycle detected: ${c}`; }
  }
  return null;
}
```

```bash
node patches/test-layout-unit.mjs
```
Expected: all tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add patches/layout.ts patches/test-layout-unit.mjs
git commit -m "feat: add cycle detection, Dagre adapter, containment resolver"
```

---

## Task 3: HTTP Helpers + `create_arrow` Tool

**Files:**
- Modify: `patches/layout.ts` — add HTTP helpers and `create_arrow` implementation

- [ ] **Step 3.1: Add HTTP helpers and `create_arrow` to `patches/layout.ts`**

Append after the Dagre section:

```typescript
// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchAllElements(): Promise<CanvasElement[]> {
  const res = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
  if (!res.ok) throw new Error(`Failed to fetch elements: ${res.status}`);
  const data = await res.json() as { elements?: CanvasElement[] };
  return data.elements || [];
}

async function putElement(el: Partial<CanvasElement> & { id: string }): Promise<void> {
  const res = await fetch(`${EXPRESS_SERVER_URL}/api/elements/${el.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(el),
  });
  if (!res.ok) throw new Error(`Failed to update element ${el.id}: ${res.status}`);
}

async function postElement(el: CanvasElement): Promise<CanvasElement> {
  const res = await fetch(`${EXPRESS_SERVER_URL}/api/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(el),
  });
  if (!res.ok) throw new Error(`Failed to create element: ${res.status}`);
  const data = await res.json() as { element: CanvasElement };
  return data.element;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** Add arrowId to element's boundElements array if not already present */
function addBoundElement(
  el: CanvasElement,
  arrowId: string
): Partial<CanvasElement> & { id: string } {
  const existing = el.boundElements || [];
  if (existing.some(b => b.id === arrowId)) return { id: el.id };
  return { id: el.id, boundElements: [...existing, { type: 'arrow', id: arrowId }] };
}

// ---------------------------------------------------------------------------
// create_arrow
// ---------------------------------------------------------------------------

interface CreateArrowArgs {
  fromId: string;
  toId: string;
  label?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  startArrowhead?: 'arrow' | 'dot' | 'bar' | null;
  endArrowhead?: 'arrow' | 'dot' | 'bar' | null;
  color?: string;
}

export async function handleCreateArrow(args: CreateArrowArgs): Promise<object> {
  const elements = await fetchAllElements();
  const fromEl = elements.find(e => e.id === args.fromId);
  const toEl   = elements.find(e => e.id === args.toId);
  if (!fromEl) throw new Error(`Element not found: ${args.fromId}`);
  if (!toEl)   throw new Error(`Element not found: ${args.toId}`);

  const fromBox: Box = { x: fromEl.x, y: fromEl.y, width: fromEl.width || 100, height: fromEl.height || 60 };
  const toBox:   Box = { x: toEl.x,   y: toEl.y,   width: toEl.width   || 100, height: toEl.height   || 60 };
  const obstacles = elements
    .filter(e => e.id !== args.fromId && e.id !== args.toId && e.width && e.height)
    .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

  const { fromPt } = nearestMidpointPair(fromBox, toBox);
  const { points, elbowed } = routeArrow(fromBox, toBox, obstacles);

  const arrowId = generateId();
  const arrow: CanvasElement = {
    id: arrowId,
    type: 'arrow',
    x: fromPt[0],
    y: fromPt[1],
    width: 0,
    height: 0,
    points: points as [number, number][],
    elbowed,
    start: { id: args.fromId, gap: 8 },
    end:   { id: args.toId,   gap: 8 },
    strokeColor: args.color || '#1e1e1e',
    strokeStyle: args.style || 'solid',
    startArrowhead: args.startArrowhead !== undefined ? args.startArrowhead : null,
    endArrowhead:   args.endArrowhead   !== undefined ? args.endArrowhead   : 'arrow',
    ...(args.label ? { label: { text: args.label } } : {}),
  };

  const created = await postElement(arrow);

  // Update boundElements on source and target
  await Promise.all([
    putElement(addBoundElement(fromEl, arrowId)),
    putElement(addBoundElement(toEl, arrowId)),
  ]);

  return { id: arrowId, element: created };
}
```

- [ ] **Step 3.2: Test `create_arrow` manually via MCP Inspector**

First ensure `mcp_excalidraw` is cloned and the library tools patch is applied:
```bash
bash scripts/init_full.sh   # if not already done
bash scripts/add_library_tools.sh
```

Create two rectangles and test `create_arrow`:
```bash
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js \
  --method tools/call --tool-name create_element \
  --tool-arg type=rectangle --tool-arg x=100 --tool-arg y=100 \
  --tool-arg width=120 --tool-arg height=60 --tool-arg id=box1
```

```bash
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js \
  --method tools/call --tool-name create_element \
  --tool-arg type=rectangle --tool-arg x=400 --tool-arg y=100 \
  --tool-arg width=120 --tool-arg height=60 --tool-arg id=box2
```

Then call `create_arrow` (after patch is applied — see Task 6):
```bash
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js \
  --method tools/call --tool-name create_arrow \
  --tool-arg fromId=box1 --tool-arg toId=box2
```
Expected: arrow appears on canvas connecting the two boxes.

- [ ] **Step 3.3: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: add HTTP helpers and create_arrow tool"
```

---

## Task 4: `move_element` Tool

**Files:**
- Modify: `patches/layout.ts` — add `handleMoveElement`

- [ ] **Step 4.1: Add `move_element` handler to `patches/layout.ts`**

Append after `handleCreateArrow`:

```typescript
// ---------------------------------------------------------------------------
// move_element
// ---------------------------------------------------------------------------

interface MoveElementArgs {
  id: string;
  x: number;
  y: number;
  arrowIds?: string[];
}

export async function handleMoveElement(args: MoveElementArgs): Promise<object> {
  const elements = await fetchAllElements();
  const el = elements.find(e => e.id === args.id);
  if (!el) throw new Error(`Element not found: ${args.id}`);

  // Update element position
  const updatedEl: Partial<CanvasElement> & { id: string } = {
    id: args.id,
    x: args.x,
    y: args.y,
  };

  // Find connected arrows
  let arrowElements: CanvasElement[];
  if (args.arrowIds && args.arrowIds.length > 0) {
    arrowElements = elements.filter(e => args.arrowIds!.includes(e.id));
  } else {
    arrowElements = elements.filter(
      e => e.type === 'arrow' && (e.start?.id === args.id || e.end?.id === args.id)
    );
  }

  // Reroute each affected arrow using full Phase 4 routing
  const movedElBox: Box = { x: args.x, y: args.y, width: el.width || 100, height: el.height || 60 };
  const updatedArrows: (Partial<CanvasElement> & { id: string })[] = [];

  for (const arrow of arrowElements) {
    const otherId = arrow.start?.id === args.id ? arrow.end?.id : arrow.start?.id;
    const otherEl = otherId ? elements.find(e => e.id === otherId) : undefined;
    if (!otherEl) continue;

    const isFrom = arrow.start?.id === args.id;
    const fromBox = isFrom ? movedElBox : { x: otherEl.x, y: otherEl.y, width: otherEl.width || 100, height: otherEl.height || 60 };
    const toBox   = isFrom ? { x: otherEl.x, y: otherEl.y, width: otherEl.width || 100, height: otherEl.height || 60 } : movedElBox;

    const obstacles = elements
      .filter(e => e.id !== args.id && e.id !== otherId && e.id !== arrow.id && e.width && e.height)
      .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

    const { fromPt } = nearestMidpointPair(fromBox, toBox);
    const { points, elbowed } = routeArrow(fromBox, toBox, obstacles);

    updatedArrows.push({
      id: arrow.id,
      x: fromPt[0],
      y: fromPt[1],
      points: points as [number, number][],
      elbowed,
    });
  }

  // Write all updates in parallel
  await Promise.all([
    putElement(updatedEl),
    ...updatedArrows.map(a => putElement(a)),
  ]);

  const finalElements = await fetchAllElements();
  return {
    element: finalElements.find(e => e.id === args.id),
    arrows: updatedArrows.map(a => finalElements.find(e => e.id === a.id)).filter(Boolean),
  };
}
```

- [ ] **Step 4.2: Test `move_element` manually**

Using the two boxes + arrow from Task 3, move box1:
```bash
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js \
  --method tools/call --tool-name move_element \
  --tool-arg id=box1 --tool-arg x=50 --tool-arg y=300
```
Expected: box1 moves, arrow reroutes to connect the new position to box2.

- [ ] **Step 4.3: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: add move_element tool with arrow rerouting"
```

---

## Task 5: `apply_layout` Tool

**Files:**
- Modify: `patches/layout.ts` — add `handleApplyLayout` and tool exports

- [ ] **Step 5.1: Add `apply_layout` handler and tool exports to `patches/layout.ts`**

Append after `handleMoveElement`:

```typescript
// ---------------------------------------------------------------------------
// apply_layout
// ---------------------------------------------------------------------------

interface ApplyLayoutArgs {
  algorithm: 'hierarchical' | 'flow';
  direction?: 'top-down' | 'left-right';
  elementIds?: string[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  spacing?: LayoutSpacing;
}

export async function handleApplyLayout(args: ApplyLayoutArgs): Promise<object> {
  const spacing: Required<LayoutSpacing> = {
    nodeSep: args.spacing?.nodeSep ?? 40,
    rankSep: args.spacing?.rankSep ?? 60,
    padding: args.spacing?.padding ?? 20,
  };

  // Phase 1: fetch and validate
  let elements = await fetchAllElements();
  if (args.elementIds && args.elementIds.length > 0) {
    const idSet = new Set(args.elementIds);
    elements = elements.filter(e => idSet.has(e.id));
  }

  const elementMap = new Map(elements.map(e => [e.id, e]));

  for (const node of args.nodes) {
    if (!elementMap.has(node.id)) throw new Error(`Node not found on canvas: ${node.id}`);
    if (node.parentId && !args.nodes.some(n => n.id === node.parentId)) {
      throw new Error(`parentId "${node.parentId}" for node "${node.id}" is not in nodes[]`);
    }
  }

  // Cycle detection for flow mode
  if (args.algorithm === 'flow') {
    const cycle = detectCycle(args.nodes, args.edges);
    if (cycle) throw new Error(cycle);
  }

  if (args.nodes.length === 0) return { updated: 0, positions: [] };

  // Resolve node dimensions
  const nodesWithSize = args.nodes.map(n => {
    const el = elementMap.get(n.id)!;
    return {
      ...n,
      resolvedWidth:  n.width  ?? (el.width  || 120),
      resolvedHeight: n.height ?? (el.height || 60),
    };
  });

  // Phase 2+3: run layout
  const positions = runDagreLayout(
    nodesWithSize,
    args.edges,
    args.algorithm,
    args.direction || 'top-down',
    spacing
  );

  // Phase 4: route arrows
  const allElements = await fetchAllElements(); // re-fetch for obstacles
  const posMap = new Map(positions.map(p => [p.id, p]));

  const arrowUpdates: (Partial<CanvasElement> & { id: string })[] = [];
  const boundElementUpdates: (Partial<CanvasElement> & { id: string })[] = [];

  for (const edge of args.edges) {
    const fromPos = posMap.get(edge.fromId);
    const toPos   = posMap.get(edge.toId);
    if (!fromPos || !toPos) continue;

    const layoutNodeIds = new Set(args.nodes.map(n => n.id));
    const obstacles = allElements
      .filter(e => !layoutNodeIds.has(e.id) && e.width && e.height && e.type !== 'arrow')
      .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

    const { fromPt } = nearestMidpointPair(fromPos, toPos);
    const { points, elbowed } = routeArrow(fromPos, toPos, obstacles);

    let arrowId = edge.arrowId;
    if (!arrowId) {
      // Create new arrow
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
    } else {
      arrowUpdates.push({ id: arrowId, x: fromPt[0], y: fromPt[1], points: points as [number, number][], elbowed });
    }

    // boundElements updates
    const fromEl = allElements.find(e => e.id === edge.fromId);
    const toEl   = allElements.find(e => e.id === edge.toId);
    if (fromEl) boundElementUpdates.push(addBoundElement(fromEl, arrowId));
    if (toEl)   boundElementUpdates.push(addBoundElement(toEl,   arrowId));
  }

  // Write node positions + arrow updates in parallel
  const nodeUpdates = positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height }));

  await Promise.all([
    ...nodeUpdates.map(u => putElement(u)),
    ...arrowUpdates.map(u => putElement(u)),
    ...boundElementUpdates.filter(u => Object.keys(u).length > 1).map(u => putElement(u)),
  ]);

  return {
    updated: nodeUpdates.length + arrowUpdates.length,
    positions: positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions + dispatcher
// ---------------------------------------------------------------------------

export const layoutTools: Tool[] = [
  {
    name: 'apply_layout',
    description: 'Arrange elements on the canvas using a configurable layout algorithm (hierarchical or flow). Supports parent-child containment, configurable spacing, and automatic arrow routing.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: ['hierarchical', 'flow'], description: 'Layout algorithm. hierarchical: Sugiyama layered tree. flow: DAG pipeline — cycles are an error.' },
        direction: { type: 'string', enum: ['top-down', 'left-right'], description: 'Layout direction. Default: top-down.' },
        elementIds: { type: 'array', items: { type: 'string' }, description: 'Optional subset of element IDs to layout. Omit to layout all.' },
        nodes: {
          type: 'array',
          description: 'Node metadata. Empty array is valid (no-op).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              parentId: { type: 'string', description: 'Parent element ID — parent box will expand to contain this node.' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['id'],
          },
        },
        edges: {
          type: 'array',
          description: 'Edges to route. Empty array is valid (no-op).',
          items: {
            type: 'object',
            properties: {
              fromId: { type: 'string' },
              toId: { type: 'string' },
              arrowId: { type: 'string', description: 'Update existing arrow. Omit to create new arrow.' },
            },
            required: ['fromId', 'toId'],
          },
        },
        spacing: {
          type: 'object',
          properties: {
            nodeSep: { type: 'number', description: 'Dagre nodesep (px between siblings). Default: 40.' },
            rankSep: { type: 'number', description: 'Dagre ranksep (px between layers). Default: 60.' },
            padding: { type: 'number', description: 'Padding inside parent boxes. Default: 20.' },
          },
        },
      },
      required: ['algorithm', 'nodes', 'edges'],
    },
  },
  {
    name: 'move_element',
    description: 'Move an element to new coordinates and automatically reroute all connected arrows. Optionally specify which arrows to reroute.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element to move.' },
        x: { type: 'number' },
        y: { type: 'number' },
        arrowIds: { type: 'array', items: { type: 'string' }, description: 'Override: only reroute these arrows. Omit to auto-detect all connected arrows.' },
      },
      required: ['id', 'x', 'y'],
    },
  },
  {
    name: 'create_arrow',
    description: 'Create a routed arrow between two existing elements. Automatically routes straight if the path is clear, elbow if blocked. Returns the arrow ID for use in apply_layout edges.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        toId:   { type: 'string' },
        label:  { type: 'string' },
        style:  { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: 'Default: solid.' },
        startArrowhead: { type: 'string', enum: ['arrow', 'dot', 'bar'], nullable: true },
        endArrowhead:   { type: 'string', enum: ['arrow', 'dot', 'bar'], nullable: true, description: 'Default: arrow.' },
        color: { type: 'string' },
      },
      required: ['fromId', 'toId'],
    },
  },
];

export async function handleLayoutTool(
  name: string,
  args: Record<string, unknown>
): Promise<object | null> {
  if (name === 'apply_layout') return handleApplyLayout(args as unknown as ApplyLayoutArgs);
  if (name === 'move_element') return handleMoveElement(args as unknown as MoveElementArgs);
  if (name === 'create_arrow') return handleCreateArrow(args as unknown as CreateArrowArgs);
  return null;
}
```

- [ ] **Step 5.2: Test `apply_layout` manually**

Clear canvas, create 4 boxes, then run apply_layout:
```bash
# Clear canvas
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js --method tools/call --tool-name clear_canvas

# Create 4 boxes at arbitrary positions
for id in root svcA svcB db; do
  EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
    -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
    node mcp_excalidraw/dist/index.js --method tools/call --tool-name create_element \
    --tool-arg type=rectangle --tool-arg x=0 --tool-arg y=0 \
    --tool-arg width=120 --tool-arg height=60 --tool-arg id=$id --tool-arg text=$id
done

# Apply hierarchical layout
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js --method tools/call --tool-name apply_layout \
  --tool-arg algorithm=hierarchical \
  --tool-arg nodes='[{"id":"root"},{"id":"svcA"},{"id":"svcB"},{"id":"db"}]' \
  --tool-arg edges='[{"fromId":"root","toId":"svcA"},{"fromId":"root","toId":"svcB"},{"fromId":"svcA","toId":"db"},{"fromId":"svcB","toId":"db"}]'
```
Expected: canvas shows a tidy top-down hierarchy with arrows.

- [ ] **Step 5.3: Test containment**

```bash
# Create a parent box and two children, then layout with containment
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js --method tools/call --tool-name apply_layout \
  --tool-arg algorithm=hierarchical \
  --tool-arg nodes='[{"id":"root"},{"id":"svcA","parentId":"container"},{"id":"svcB","parentId":"container"},{"id":"container"}]' \
  --tool-arg edges='[{"fromId":"root","toId":"container"}]'
```
Expected: `container` expands to wrap `svcA` and `svcB`; `root` is positioned above.

- [ ] **Step 5.4: Commit**

```bash
git add patches/layout.ts
git commit -m "feat: add apply_layout tool with full pipeline"
```

---

## Task 6: Patcher, Shell Script, Commands, and Wiring

**Files:**
- Create: `patches/patch-index-layout.mjs`
- Create: `scripts/add_layout_tools.sh`
- Modify: `scripts/init_full.sh`
- Create: `.claude/commands/add-layout-tools.md`
- Create: `.cursor/commands/add-layout-tools.md`

- [ ] **Step 6.1: Create `patches/patch-index-layout.mjs`**

```javascript
#!/usr/bin/env node
// Idempotent patcher for mcp_excalidraw/src/index.ts
// Adds apply_layout, move_element, create_arrow tool support.
// Must be run AFTER patch-index.mjs (library tools patch).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET = path.resolve(__dirname, '../mcp_excalidraw/src/index.ts');

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Target file not found: ${TARGET}`);
  console.error('Run scripts/init.sh first to clone and build mcp_excalidraw.');
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');

// Prerequisite check: library tools patch must be applied first
const PREREQ_IMPORT = "import { libraryTools, handleLibraryTool } from './library-tools.js';";
const PREREQ_PUSH   = "tools.push(...libraryTools);";
if (!src.includes(PREREQ_IMPORT) || !src.includes(PREREQ_PUSH)) {
  console.error('ERROR: Library tools patch must be applied before layout tools patch.');
  console.error('Run: bash scripts/add_library_tools.sh');
  process.exit(1);
}

// Guard: skip if already patched
const GUARD = "import { layoutTools, handleLayoutTool } from './layout.js';";
if (src.includes(GUARD)) {
  console.log('patch-index-layout.mjs: already patched, skipping.');
  process.exit(0);
}

// Patch 1: import — insert after library-tools import
const IMPORT_ANCHOR = "import { libraryTools, handleLibraryTool } from './library-tools.js';";
if (!src.includes(IMPORT_ANCHOR)) {
  console.error(`ERROR: Anchor not found: ${IMPORT_ANCHOR}`);
  process.exit(1);
}
src = src.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${GUARD}`);
console.log('patch-index-layout.mjs: patch 1/3 applied (import).');

// Patch 2: tools registration — insert after libraryTools push
const TOOLS_ANCHOR = "tools.push(...libraryTools);";
if (!src.includes(TOOLS_ANCHOR)) {
  console.error(`ERROR: Anchor not found: ${TOOLS_ANCHOR}`);
  process.exit(1);
}
src = src.replace(TOOLS_ANCHOR, `${TOOLS_ANCHOR}\ntools.push(...layoutTools);`);
console.log('patch-index-layout.mjs: patch 2/3 applied (tools.push).');

// Patch 3: switch cases — insert before default:
const DEFAULT_ANCHOR = '\n      default:\n        throw new Error(`Unknown tool: ${name}`);';
if (!src.includes(DEFAULT_ANCHOR)) {
  console.error('ERROR: default case anchor not found.');
  process.exit(1);
}
const LAYOUT_CASES = `
      case 'apply_layout':
      case 'move_element':
      case 'create_arrow': {
        const result = await handleLayoutTool(name, args as Record<string, unknown>);
        if (result === null) throw new Error(\`Unknown tool: \${name}\`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
`;
src = src.replace(DEFAULT_ANCHOR, `${LAYOUT_CASES}      default:\n        throw new Error(\`Unknown tool: \${name}\`);`);
console.log('patch-index-layout.mjs: patch 3/3 applied (switch cases).');

fs.writeFileSync(TARGET, src, 'utf8');
console.log('patch-index-layout.mjs: index.ts patched successfully.');
```

- [ ] **Step 6.2: Test the patcher against mcp_excalidraw (after library patch is applied)**

```bash
# Verify library patch is applied
grep -c "libraryTools" mcp_excalidraw/src/index.ts
# Expected: 2 or more

# Run layout patcher (dry run — check output only)
node patches/patch-index-layout.mjs
# Expected: 3 patches applied, no errors

# Run again — idempotency check
node patches/patch-index-layout.mjs
# Expected: "already patched, skipping."

# Verify the 3 insertions are present
grep -c "layoutTools\|handleLayoutTool\|apply_layout\|move_element\|create_arrow" mcp_excalidraw/src/index.ts
# Expected: 5 or more matches
```

- [ ] **Step 6.3: Create `scripts/add_layout_tools.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dagre dependency"
cd mcp_excalidraw
npm install dagre
npm install --save-dev @types/dagre
cd ..

echo "==> Copying layout.ts into mcp_excalidraw/src/"
cp patches/layout.ts mcp_excalidraw/src/layout.ts

echo "==> Patching mcp_excalidraw/src/index.ts"
node patches/patch-index-layout.mjs

echo "==> Rebuilding MCP server"
cd mcp_excalidraw && npm run build:server

echo "==> Done. Restart the MCP server to activate the new tools:"
echo "    apply_layout"
echo "    move_element"
echo "    create_arrow"
```

Make it executable:
```bash
chmod +x scripts/add_layout_tools.sh
```

- [ ] **Step 6.4: Run the full script end-to-end**

```bash
bash scripts/add_layout_tools.sh
```
Expected: dagre installs, layout.ts copied, index.ts patched, server rebuilds with no TypeScript errors.

- [ ] **Step 6.5: Update `scripts/init_full.sh` to add step 5**

Run these exact sed commands to update step labels and append the new step:

```bash
# Update step labels [1/4]–[4/4] → [1/5]–[4/5]
sed -i '' 's/\[1\/4\]/[1\/5]/g; s/\[2\/4\]/[2\/5]/g; s/\[3\/4\]/[3\/5]/g; s/\[4\/4\]/[4\/5]/g' scripts/init_full.sh

# Verify the 4 labels were updated
grep -c "\[./5\]" scripts/init_full.sh
# Expected: 4
```

Then append the new step. Open `scripts/init_full.sh` and insert before the final `echo "==> Done."` block:

```bash
echo ""
echo "==> [5/5] Patch MCP server with layout tools (apply_layout, move_element, create_arrow)"
bash scripts/add_layout_tools.sh
```

The final `scripts/init_full.sh` done section should read:
```bash
echo ""
echo "==> [5/5] Patch MCP server with layout tools (apply_layout, move_element, create_arrow)"
bash scripts/add_layout_tools.sh

echo ""
echo "==> Done."
echo ""
echo "    Remaining step: register the copied libraries in App.tsx and rebuild."
echo "    Run the /add-libraries command (Claude Code) or add-libraries (Cursor)."
echo ""
echo "    Then start the canvas:"
echo "    bash scripts/run_canvas.sh"
```

- [ ] **Step 6.6: Create `.claude/commands/add-layout-tools.md`**

```markdown
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
```

- [ ] **Step 6.7: Create `.cursor/commands/add-layout-tools.md`** (identical content)

```markdown
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
```

- [ ] **Step 6.8: Update README.md Scripts and Commands tables**

In `README.md`, add to the Scripts table:
```
| `scripts/add_layout_tools.sh` | Installs dagre and patches MCP server with `apply_layout`, `move_element`, `create_arrow` tools. |
```

Add to both commands tables:
```
| `add-layout-tools` / `/add-layout-tools` | Patch MCP server with layout engine tools, then rebuild. |
```

Update "Option A" Quick Start to reference the new step count (5 steps now covered by `init_full.sh`).

- [ ] **Step 6.9: Final integration test**

```bash
# Full fresh setup
bash scripts/init_full.sh

# Start canvas
bash scripts/run_canvas.sh &

# Verify all 3 new tools appear in tools/list
EXPRESS_SERVER_URL=http://localhost:3000 npx @modelcontextprotocol/inspector --cli \
  -e EXPRESS_SERVER_URL=http://localhost:3000 -- \
  node mcp_excalidraw/dist/index.js --method tools/list | grep -E "apply_layout|move_element|create_arrow"
# Expected: 3 matches
```

- [ ] **Step 6.10: Commit everything**

```bash
git add patches/patch-index-layout.mjs patches/test-layout-unit.mjs \
        scripts/add_layout_tools.sh scripts/init_full.sh \
        .claude/commands/add-layout-tools.md .cursor/commands/add-layout-tools.md \
        README.md
git commit -m "feat: add layout engine patch — apply_layout, move_element, create_arrow"
git push
```
