// patches/layout.test.ts
// Run from mcp_excalidraw/ dir: npx --yes tsx ../patches/layout.test.ts
// Requires: bash scripts/add_layout_tools.sh to have been run first

import assert from 'node:assert/strict';
import {
  routeArrow,
  segmentIntersectsBox,
  countElbowIntersections,
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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
