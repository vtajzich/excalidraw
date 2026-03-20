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
// Implementations are inlined to avoid a TypeScript compile step.
// layout.ts is the source of truth; keep these in sync if geometry functions change.

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
