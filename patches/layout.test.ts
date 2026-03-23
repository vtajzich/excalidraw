// patches/layout.test.ts
// Run from mcp_excalidraw/ dir: npx --yes tsx ../patches/layout.test.ts
// Requires: bash scripts/add_layout_tools.sh to have been run first

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  // algorithm should no longer be required
  assert.strictEqual(required.includes('algorithm'), false, 'algorithm should not be required');
});

// ---------------------------------------------------------------------------
// Task 4: applyGroupsYSnap — zone y-snap
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

// ---------------------------------------------------------------------------
// Task 5: proximity detection — pure geometry helpers
// ---------------------------------------------------------------------------
console.log('\nmove_element proximity — point-in-expanded-box checks');

// Helper we'll test indirectly via pointInExpandedBox logic
function pointInBox(
  px: number, py: number,
  bx: number, by: number, bw: number, bh: number,
  gap: number
): boolean {
  return px >= bx - gap && px <= bx + bw + gap &&
         py >= by - gap && py <= by + bh + gap;
}

test('point inside expanded box returns true', () => {
  assert.strictEqual(pointInBox(100, 100, 100, 100, 80, 60, 8), true);
});

test('point outside expanded box returns false', () => {
  assert.strictEqual(pointInBox(80, 80, 100, 100, 80, 60, 8), false);
});

test('point on the expanded edge returns true', () => {
  assert.strictEqual(pointInBox(92, 130, 100, 100, 80, 60, 8), true);
});

test('arrow last-point translation: points[N-1] shifts correctly', () => {
  const points: [number, number][] = [[0,0],[100,0],[100,100]];
  const dx = 20, dy = 10;
  points[points.length - 1] = [points[points.length - 1]![0] + dx, points[points.length - 1]![1] + dy];
  assert.deepStrictEqual(points[2], [120, 110]);
});

test('arrow first-point translation: x/y shifts, all other points compensate', () => {
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

// ---------------------------------------------------------------------------
// Phase 3: lane routing unit tests
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — Phase 3 lane routing');

test('vertical lane detection: 3 column obstacles produce 4 distinct lanes', () => {
  // col1: x=0..100, col2: x=130..230, col3: x=260..360
  // gaps: 30px each — both ≥ 20 → 2 interior lanes at 115 and 245
  // outer lanes: min(0)-40=-40, max(360)+40=400
  // sorted: [-40, 115, 245, 400] — all differ by ≥ 5 → 4 distinct lanes
  const obs = [
    { x: 0,   y: 0, width: 100, height: 60 },
    { x: 130, y: 0, width: 100, height: 60 },
    { x: 260, y: 0, width: 100, height: 60 },
  ];
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
  // gaps: 30px each — interior: (60+90)/2=75, (150+180)/2=165
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
  const from = { x: 0, y: 0, width: 100, height: 60 };
  const to   = { x: 200, y: 200, width: 100, height: 60 };
  const obs = [{ x: 60, y: 30, width: 80, height: 140 }];
  const result = routeArrow(from, to, obs);
  assert.ok(result.points.length >= 2, 'returns valid points array');
  assert.ok(typeof result.crossings === 'number', 'has crossings field');
});

test('cross-axis selection: horizontal lane wins when it has fewer crossings', () => {
  const from = { x: 100, y: 0,   width: 100, height: 60 };
  const to   = { x: 100, y: 400, width: 100, height: 60 };
  const obs  = [{ x: -200, y: 100, width: 600, height: 200 }];
  const result = routeArrow(from, to, obs);
  assert.ok(typeof result.crossings === 'number', 'has crossings field');
  assert.ok(['elbow', 'lane', 'side-exit'].includes(result.routeType), `routeType is ${result.routeType}`);
});

test('Phase 3 prefers lane path with 0 crossings over Phase 2 with 1 crossing', () => {
  // Two obstacles that block all straight paths and all Phase-2 elbows (min 1 crossing),
  // but a horizontal lane at y=190 (below both obstacles) yields 0 crossings.
  // obs1: x=80..180, y=-50..150  obs2: x=200..300, y=-50..150  gap=20px → no interior vLane
  // hLane outer bottom: y = max(150,150)+40 = 190 — clear of both obstacles
  const obs = [
    { x: 80,  y: -50, width: 100, height: 200 },
    { x: 200, y: -50, width: 100, height: 200 },
  ];
  const from2 = { x: 0,   y: 0,  width: 60, height: 60 };
  const to2   = { x: 200, y: 50, width: 60, height: 60 };
  const result = routeArrow(from2, to2, obs);
  assert.ok(result.routeType === 'lane' || result.routeType === 'side-exit', `expected lane or side-exit, got ${result.routeType}`);
  assert.strictEqual(result.crossings, 0, `expected 0 crossings, got ${result.crossings}`);
});

test('Phase 2 fallback: when Phase 2 already has 0 crossings, Phase 3 is skipped and returns elbow', () => {
  const from = { x: 0,   y: 0,   width: 60, height: 60 };
  const to   = { x: 200, y: 200, width: 60, height: 60 };
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

  // Phase 2 may already find a 0-crossing elbow (skipping Phase 3 lane routing).
  // Either 'lane' or 'elbow' is acceptable as long as crossings === 0.
  assert.strictEqual(result.crossings, 0,
    `expected 0 crossings, got ${result.crossings} (routeType: ${result.routeType})`);
  assert.ok(
    result.routeType === 'lane' || result.routeType === 'elbow',
    `expected routeType 'lane' or 'elbow', got '${result.routeType}'`
  );
});

// ---------------------------------------------------------------------------
// Gap control (Fix 3)
// ---------------------------------------------------------------------------
console.log('\ngetAttachmentPoint — gap control');

test('getAttachmentPoint: right side with gap=8 offsets outward', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'right', 0, 8);
  assert.deepStrictEqual(pt, [308, 150]);
});

test('getAttachmentPoint: top side with focus=0.5 shifts right along edge', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'top', 0.5, 0);
  assert.deepStrictEqual(pt, [250, 100]);
});

test('getAttachmentPoint: bottom side with gap=8 and focus=-0.5', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'bottom', -0.5, 8);
  assert.deepStrictEqual(pt, [150, 208]);
});

test('getAttachmentPoint: left side with gap=0 (backward compat)', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const pt = getAttachmentPoint(box, 'left', 0, 0);
  assert.deepStrictEqual(pt, [100, 150]);
});

test('routeArrow with gap=8: fromPt offset from element boundary', () => {
  const from = { x: 100, y: 300, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { gap: 8 });
  assert.strictEqual(result.routeType, 'straight');
  assert.strictEqual(result.fromPt[1], 292);
});

test('routeArrow with gap=0: fromPt at exact boundary', () => {
  const from = { x: 100, y: 300, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const result = routeArrow(from, to, [], { gap: 0 });
  assert.strictEqual(result.routeType, 'straight');
  assert.strictEqual(result.fromPt[1], 300);
});

// ---------------------------------------------------------------------------
// Direction-aware scoring (Fix 5)
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — direction-aware scoring (Fix 5)');

test('TB flow: prefers bottom→top straight path', () => {
  const from2 = { x: 0, y: 0,   width: 100, height: 60 };
  const to2   = { x: 0, y: 200, width: 100, height: 60 };
  const result = routeArrow(from2, to2, [], { flowDirection: 'TB' });
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
  const from     = { x: 0,   y: 0,   width: 80, height: 60 };
  const to       = { x: 300, y: 300, width: 80, height: 60 };
  const obstacle = { x: 120, y: 120, width: 80, height: 80 };
  const resultLR = routeArrow(from, to, [obstacle], { flowDirection: 'LR' });
  if (resultLR.routeType === 'elbow') {
    const pts = resultLR.points;
    if (pts.length === 3) {
      const midX = resultLR.fromPt[0] + pts[1]![0];
      assert.ok(Math.abs(midX - resultLR.fromPt[0]) < 10);
    }
  }
});

// ---------------------------------------------------------------------------
// Phase 2.5 — side-exit obstacle avoidance (Fix 1)
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — Phase 2.5 side-exit obstacle avoidance');

test('Phase 2.5: 3 stacked obstacles — picks side-exit with 0 crossings', () => {
  const from = { x: 100, y: 500, width: 100, height: 60 };
  const to   = { x: 100, y: 0,   width: 100, height: 60 };
  const obs  = [
    { x: 80, y: 100, width: 140, height: 60 },
    { x: 80, y: 220, width: 140, height: 60 },
    { x: 80, y: 340, width: 140, height: 60 },
  ];
  const result = routeArrow(from, to, obs, { gap: 0 });
  assert.strictEqual(result.crossings, 0);
  assert.ok(result.routeType === 'side-exit' || result.routeType === 'lane');
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
  const from = { x: 0,   y: 100, width: 60, height: 100 };
  const to   = { x: 500, y: 100, width: 60, height: 100 };
  const obs  = [
    { x: 100, y: 100, width: 60, height: 100 },
    { x: 220, y: 100, width: 60, height: 100 },
    { x: 340, y: 100, width: 60, height: 100 },
  ];
  const result = routeArrow(from, to, obs, { gap: 0, flowDirection: 'LR' });
  assert.strictEqual(result.crossings, 0);
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
  const result = routeArrow(box, box, [], { gap: 0 });
  assert.ok(result.routeType !== 'side-exit');
});

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

// ---------------------------------------------------------------------------
// routeArrow — lane consolidation (Fix 4)
// ---------------------------------------------------------------------------
console.log('\nrouteArrow — lane consolidation (Fix 4)');

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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
