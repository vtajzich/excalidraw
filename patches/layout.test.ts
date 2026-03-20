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
} from '../mcp_excalidraw/src/layout.ts';

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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
