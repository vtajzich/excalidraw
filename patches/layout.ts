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
  arrowGap?: number;
}

export interface LayoutGroup {
  id: string;
  memberIds: string[];
  rank: number;
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

type Side = 'top' | 'bottom' | 'left' | 'right';

interface RouteOptions {
  flowDirection?: 'TB' | 'LR';
  startFocus?: number;
  endFocus?: number;
  gap?: number;
  preferSide?: Side;
  entrySide?: Side;
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

interface RoutedEdge {
  arrowId: string;
  fromId: string;
  toId: string;
  entrySide: Side;
  exitSide: Side;
  fromPt: Point;
  points: Point[];
  elbowed: boolean;
  laneCoord?: number;
  laneAxis?: 'x' | 'y';
}

const DEFAULT_GAP = 8;
const MIN_LANE_GAP = 20;
const LANE_OUTER_MARGIN = 40;
const LANE_DEDUP_THRESHOLD = 5;
const LANE_SNAP_THRESHOLD = 30;
const FAN_OUT_RANGE = 0.7;
const AXIS_DOMINANCE_THRESHOLD = 20;

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

export function computeFanOut(n: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) =>
    -FAN_OUT_RANGE + 2 * FAN_OUT_RANGE * i / (n - 1)
  );
}

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

/** Derive the entry side of an arrow from its path points and target box. */
function deriveEntrySide(points: Point[], arrowX: number, arrowY: number, _target: Box): Side {
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

/**
 * Returns true if segment p1→p2 properly crosses the boundary of box.
 * Uses strict segment-crossing test: returns false if segment is entirely inside,
 * or if it only grazes a corner without crossing (collinear/endpoint-touch not detected).
 * Callers exclude source and target elements before calling this.
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
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (a === undefined || b === undefined) continue;
    for (const box of obstacles) {
      if (segmentIntersectsBox(a, b, box)) count++;
    }
  }
  return count;
}

interface DetectedLanes {
  vertical: number[];
  horizontal: number[];
}

export function detectLanes(obstacles: Box[]): DetectedLanes {
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
  obstacles: Box[],
  options: RouteOptions = {}
): RouteResult {
  const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
  const { gap = 0, startFocus, endFocus, entrySide: pinnedEntrySide, flowDirection } = options;
  const targetSides: Side[] = pinnedEntrySide ? [pinnedEntrySide] : SIDES;

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

  // Phase 1: find the shortest clear straight path across all 16 pairs
  let bestStraight: { fromPt: Point; toPt: Point; dist: number; exitSide: Side; entrySide: Side } | null = null;
  for (const fk of SIDES) {
    for (const tk of targetSides) {
      const fp = fromPts[fk];
      const tp = toPts[tk];
      if (obstacles.some(obs => segmentIntersectsBox(fp, tp, obs))) continue;
      const dist = Math.hypot(fp[0] - tp[0], fp[1] - tp[1]);
      const flowAligned =
        (flowDirection === 'TB' && fk === 'bottom' && tk === 'top') ||
        (flowDirection === 'LR' && fk === 'right'  && tk === 'left');
      const adjustedDist = flowAligned ? dist * 0.99 : dist;
      if (!bestStraight || adjustedDist < bestStraight.dist) {
        bestStraight = { fromPt: fp, toPt: tp, dist: adjustedDist, exitSide: fk, entrySide: tk };
      }
    }
  }

  if (bestStraight) {
    const { fromPt, toPt, exitSide, entrySide } = bestStraight;
    return {
      points: [[0, 0], [toPt[0] - fromPt[0], toPt[1] - fromPt[1]]],
      elbowed: false,
      fromPt,
      crossings: 0,
      routeType: 'straight',
      exitSide,
      entrySide,
    };
  }

  // Phase 2: try all 32 elbow candidates (16 pairs × H-first + V-first)
  interface ElbowCandidate {
    waypoints: Point[];
    fromPt: Point;
    count: number;
    isHorizontalFirst: boolean;
    totalLength: number;
    exitSide: Side;
    entrySide: Side;
  }
  let best: ElbowCandidate | null = null;

  for (const fk of SIDES) {
    for (const tk of targetSides) {
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

        const preferH = flowDirection !== 'LR';
        const better =
          !best ||
          count < best.count ||
          (count === best.count && (preferH ? isH && !best.isHorizontalFirst : !isH && best.isHorizontalFirst)) ||
          (count === best.count && isH === best.isHorizontalFirst && totalLength < best.totalLength);

        if (better) {
          best = { waypoints, fromPt: fp, count, isHorizontalFirst: isH, totalLength, exitSide: fk, entrySide: tk };
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
      crossings: 0,
      routeType: 'elbow',
      exitSide: 'right',
      entrySide: 'left',
    };
  }

  const phase2CrossingCount = best.count;
  const origin = best.fromPt;

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

    let exitSides: Side[];
    if (options.preferSide) {
      exitSides = [options.preferSide];
    } else if (flowDirection === 'TB') {
      exitSides = ['left', 'right'];
    } else if (flowDirection === 'LR') {
      exitSides = ['top', 'bottom'];
    } else if (Math.abs(adx - ady) < AXIS_DOMINANCE_THRESHOLD) {
      exitSides = ['top', 'right', 'bottom', 'left'];
    } else if (ady > adx) {
      exitSides = ['left', 'right'];
    } else {
      exitSides = ['top', 'bottom'];
    }

    const entrySides25: Side[] = pinnedEntrySide ? [pinnedEntrySide] : ['top', 'right', 'bottom', 'left'];
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
      for (const ns of entrySides25) {
        const fp = fromPts[es];
        const tp = toPts[ns];
        const lanes = (es === 'left' || es === 'right') ? vLanes25 : hLanes25;

        for (const laneCoord of lanes) {
          let waypoints: Point[];
          if (es === 'left' || es === 'right') {
            waypoints = [fp, [laneCoord, fp[1]], [laneCoord, tp[1]], tp];
          } else {
            waypoints = [fp, [fp[0], laneCoord], [tp[0], laneCoord], tp];
          }

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

  if (phase25Result && phase25Result.crossings === 0) {
    return phase25Result;
  }

  const phase25Crossings = phase25Result?.crossings ?? phase2CrossingCount;
  if (phase25Crossings > 0 && obstacles.length > 0) {
    const { vertical: vLanes, horizontal: hLanes } = detectLanes(obstacles);

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
    let winner: LaneCandidate | null = null;

    function tryLane(waypoints: Point[], fp: Point, axis: 'x' | 'y', coord: number, es: Side, ns: Side): void {
      // Degenerate filter: discard if any two consecutive waypoints are identical
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (waypoints[i]![0] === waypoints[i + 1]![0] && waypoints[i]![1] === waypoints[i + 1]![1]) return;
      }
      const count = countElbowIntersections(waypoints, obstacles);
      const totalLength = waypoints.slice(1).reduce((sum, pt, i) => {
        const prev = waypoints[i]!;
        return sum + Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      }, 0);
      if (!winner || count < winner.count || (count === winner.count && totalLength < winner.totalLength)) {
        winner = { waypoints, fromPt: fp, count, totalLength, axis, coord, exitSide: es, entrySide: ns };
      }
    }

    for (const lx of vLanes) {
      for (const fk of SIDES) {
        for (const tk of targetSides) {
          const fp = fromPts[fk];
          const tp = toPts[tk];
          tryLane([fp, [lx, fp[1]], [lx, tp[1]], tp], fp, 'x', lx, fk, tk);
        }
      }
    }

    for (const ly of hLanes) {
      for (const fk of SIDES) {
        for (const tk of targetSides) {
          const fp = fromPts[fk];
          const tp = toPts[tk];
          tryLane([fp, [fp[0], ly], [tp[0], ly], tp], fp, 'y', ly, fk, tk);
        }
      }
    }

    if (winner !== null && (winner as LaneCandidate).count < phase25Crossings) {
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
        exitSide: w.exitSide,
        entrySide: w.entrySide,
      };
    }
  }

  if (phase25Result && phase25Result.crossings < phase2CrossingCount) {
    return phase25Result;
  }

  return {
    points: best.waypoints.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
    fromPt: origin,
    crossings: best.count,
    routeType: 'elbow',
    exitSide: best.exitSide,
    entrySide: best.entrySide,
  };
}

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

export interface ResolvedPosition {
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
  // Only populated for nodes that have a parentId — root nodes are handled by Pass B directly.

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

  // Pass B: layout root nodes + parents with correct sizes
  const g2 = new dagre.graphlib.Graph();
  g2.setGraph({ rankdir, nodesep: spacing.nodeSep, ranksep: spacing.rankSep });
  g2.setDefaultEdgeLabel(() => ({}));

  const rootIds = childrenOf.get(undefined) || [];
  const parentIds = [...childrenOf.keys()].filter(k => k !== undefined) as string[];

  for (const id of rootIds) {
    if (childrenOf.has(id)) continue; // root-parents are registered in the parentIds loop below
    const n = nodeMap.get(id)!;
    g2.setNode(id, { width: n.resolvedWidth, height: n.resolvedHeight });
  }
  for (const id of parentIds) {
    const size = computedSizes.get(id) || { w: 100, h: 100 };
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

  // Root nodes: use Pass B positions directly.
  // Skip nodes that are also parents — they will be handled by the parentIds loop.
  for (const id of rootIds) {
    if (childrenOf.has(id)) continue;
    const { x, y } = g2.node(id);
    const n = nodeMap.get(id)!;
    results.push({ id, x: x - n.resolvedWidth / 2, y: y - n.resolvedHeight / 2, width: n.resolvedWidth, height: n.resolvedHeight });
  }

  // Parents + their children: use Pass B for parent origin, Phase 3 sets final bbox
  for (const id of parentIds) {
    const { x, y } = g2.node(id);
    const size = computedSizes.get(id)!;
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

    // Normalize: Dagre's child coords may not start at (0,0); subtract the group's min offset.
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
    const childSet2 = new Set(childIds);
    const childResults = results.filter(r => childSet2.has(r.id));
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
    return nodeHeightMap.get(id) ?? posHeightMap.get(id) ?? 60;
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
  if (!data.element) throw new Error('postElement: unexpected response shape from server');
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
  startFocus?: number;
  endFocus?: number;
  gap?: number;
  flowDirection?: 'TB' | 'LR';
  preferSide?: 'top' | 'bottom' | 'left' | 'right';
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
    .filter(e => e.id !== args.fromId && e.id !== args.toId && e.type !== 'arrow' && e.width && e.height)
    .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

  const dx = Math.abs((toBox.x + toBox.width / 2) - (fromBox.x + fromBox.width / 2));
  const dy = Math.abs((toBox.y + toBox.height / 2) - (fromBox.y + fromBox.height / 2));
  const inferredFlow: 'TB' | 'LR' = dy > dx ? 'TB' : 'LR';
  const routeOpts: RouteOptions = {
    gap: args.gap ?? DEFAULT_GAP,
    flowDirection: args.flowDirection ?? inferredFlow,
    startFocus: args.startFocus,
    endFocus: args.endFocus,
    preferSide: args.preferSide,
  };
  const { points, elbowed, fromPt, crossings, routeType, exitSide, entrySide, laneAxis, laneCoord } =
    routeArrow(fromBox, toBox, obstacles, routeOpts);

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
    start: { id: args.fromId, gap: DEFAULT_GAP },
    end:   { id: args.toId,   gap: DEFAULT_GAP },
    strokeColor: args.color || '#1e1e1e',
    strokeStyle: args.style || 'solid',
    startArrowhead: args.startArrowhead !== undefined ? args.startArrowhead : null,
    endArrowhead:   args.endArrowhead   !== undefined ? args.endArrowhead   : 'arrow',
    ...(args.label ? { label: { text: args.label } } : {}),
  };

  const created = await postElement(arrow);

  // Update boundElements on source and target in parallel
  const bindUpdates = [
    addBoundElement(fromEl, arrowId),
    addBoundElement(toEl, arrowId),
  ].filter(u => Object.keys(u).length > 1);
  if (bindUpdates.length > 0) {
    await Promise.all(bindUpdates.map(u => putElement(u)));
  }

  const routing: Record<string, unknown> = { type: routeType, crossings, exitSide, entrySide };
  if (routeType === 'lane') {
    if (laneAxis === 'x') routing.laneX = laneCoord;
    else if (laneAxis === 'y') routing.laneY = laneCoord;
    if (laneAxis !== undefined) routing.laneAxis = laneAxis;
    if (laneCoord !== undefined) routing.laneCoord = laneCoord;
  }

  // Incremental fan-out: re-spread arrows sharing same (targetId, entrySide)
  if (!args.startFocus && !args.endFocus) {  // skip if user pinned focus
    const allEls = await fetchAllElements();
    const targetArrows = allEls.filter(e =>
      e.type === 'arrow' &&
      (e.end?.id === args.toId || (e as any).endBinding?.elementId === args.toId)
    );

    if (targetArrows.length > 1) {
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
          const aStart = a.start?.id || (a as any).startBinding?.elementId;
          const bStart = b.start?.id || (b as any).startBinding?.elementId;
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
          const aStartId = a.start?.id || (a as any).startBinding?.elementId;
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

  return { id: arrowId, element: created, routing };
}

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

  // Reroute each affected arrow using full Phase 4 routing
  const movedElBox: Box = { x: args.x, y: args.y, width: el.width || 100, height: el.height || 60 };
  const updatedArrows: (Partial<CanvasElement> & { id: string })[] = [];

  // Track which arrows need translation vs full reroute.
  // Any arrow (manual or auto-detected) that lacks binding to the moved element
  // uses translation instead of routeArrow — routeArrow requires known from/to IDs.
  const proximityArrowIds: Set<string> = new Set(
    arrowElements
      .filter(e => !(e.start?.id === args.id || e.end?.id === args.id))
      .map(e => e.id)
  );

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
      const firstInBox = inBox(firstAbs[0], firstAbs[1]);
      const lastInBox  = inBox(lastAbs[0],  lastAbs[1]);

      const newPts: [number, number][] = pts.map(p => [p[0], p[1]]);
      let newArrowX = arrow.x;
      let newArrowY = arrow.y;

      if (firstInBox && lastInBox) {
        // Self-loop: both endpoints in box — translate entire arrow
        newArrowX += dx;
        newArrowY += dy;
        // points unchanged
      } else {
        // Determine attached endpoint by center distance (spec requirement)
        const elCx = el.x + (el.width || 100) / 2;
        const elCy = el.y + (el.height || 60) / 2;
        const distFirst = Math.hypot(firstAbs[0] - elCx, firstAbs[1] - elCy);
        const distLast  = Math.hypot(lastAbs[0]  - elCx, lastAbs[1]  - elCy);

        if (distFirst <= distLast) {
          // First point is attached — shift origin, compensate all other points
          newArrowX += dx;
          newArrowY += dy;
          for (let i = 1; i < newPts.length; i++) {
            newPts[i] = [newPts[i]![0] - dx, newPts[i]![1] - dy];
          }
          // newPts[0] stays [0,0]
        } else {
          // Last point is attached — shift only last point
          const last = newPts[newPts.length - 1]!;
          newPts[newPts.length - 1] = [last[0] + dx, last[1] + dy];
        }
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

    const mdx = Math.abs((toBox.x + toBox.width / 2) - (fromBox.x + fromBox.width / 2));
    const mdy = Math.abs((toBox.y + toBox.height / 2) - (fromBox.y + fromBox.height / 2));
    const moveInferredFlow: 'TB' | 'LR' = mdy > mdx ? 'TB' : 'LR';
    const { points, elbowed, fromPt } = routeArrow(fromBox, toBox, obstacles, { gap: DEFAULT_GAP, flowDirection: moveInferredFlow });

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

// ---------------------------------------------------------------------------
// apply_layout
// ---------------------------------------------------------------------------

interface ApplyLayoutArgs {
  algorithm?: 'hierarchical' | 'flow';  // optional: not needed for edges-only mode
  direction?: 'top-down' | 'left-right';
  elementIds?: string[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  spacing?: LayoutSpacing;
  mode?: 'layout' | 'edges-only';
  groups?: LayoutGroup[];
}

async function handleEdgesOnly(
  args: ApplyLayoutArgs,
  spacing: Required<LayoutSpacing>
): Promise<object> {
  const arrowGap = spacing.arrowGap ?? DEFAULT_GAP;
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

  const routingSummary = {
    totalEdges: args.edges.length,
    clean: 0,
    withCrossings: 0,
    edges: [] as { fromId: string; toId: string; crossings: number; type: string }[],
  };

  const routedEdges: RoutedEdge[] = [];

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

    const flowDirection: 'TB' | 'LR' = args.direction === 'left-right' ? 'LR' : 'TB';
    const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType, exitSide, entrySide, laneAxis, laneCoord } = routeArrow(fromBox, toBox, obstacles, { gap: arrowGap, flowDirection });
    if (edgeCrossings > 0) {
      routingSummary.withCrossings++;
      routingSummary.edges.push({ fromId: edge.fromId, toId: edge.toId, crossings: edgeCrossings, type: edgeRouteType });
    } else {
      routingSummary.clean++;
    }

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
        start: { id: edge.fromId, gap: DEFAULT_GAP },
        end:   { id: edge.toId,   gap: DEFAULT_GAP },
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

    routedEdges.push({
      arrowId: arrowId!,
      fromId: edge.fromId,
      toId: edge.toId,
      entrySide,
      exitSide,
      fromPt,
      points: points as Point[],
      elbowed,
      laneAxis,
      laneCoord,
    });

    if (fromEl) accumulateBound(fromEl, arrowId);
    if (toEl)   accumulateBound(toEl,   arrowId);
  }

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

      const fanObstacles = allElements
        .filter(e => e.id !== re.fromId && e.id !== re.toId && e.type !== 'arrow' && e.width && e.height)
        .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

      const rerouted = routeArrow(fromBox, toBox, fanObstacles, {
        gap: DEFAULT_GAP,
        endFocus: focus,
        entrySide: re.entrySide,
      });

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

  // Lane consolidation: snap nearby lane coordinates to shared values
  const laneGroupsEO = new Map<string, { arrowId: string; laneCoord: number; laneAxis: 'x' | 'y' }[]>();
  for (const re of routedEdges) {
    if (re.laneCoord !== undefined && re.laneAxis) {
      const key = `${re.exitSide}:${re.laneAxis}`;
      const group = laneGroupsEO.get(key) ?? [];
      group.push({ arrowId: re.arrowId, laneCoord: re.laneCoord, laneAxis: re.laneAxis });
      laneGroupsEO.set(key, group);
    }
  }

  const allObstaclesEO = allElements
    .filter(e => e.type !== 'arrow' && e.width && e.height)
    .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

  for (const [, group] of laneGroupsEO) {
    if (group.length <= 1) continue;
    const coords = group.map(g => g.laneCoord);
    const axis = group[0]!.laneAxis;
    snapLanes(coords, LANE_SNAP_THRESHOLD, allObstaclesEO, axis);
    // Lane snapping computed — integration with re-routing left as future work
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
    routingSummary,
  };
}

export async function handleApplyLayout(args: ApplyLayoutArgs): Promise<object> {
  const spacing: Required<LayoutSpacing> = {
    nodeSep: args.spacing?.nodeSep ?? 40,
    rankSep: args.spacing?.rankSep ?? 60,
    padding: args.spacing?.padding ?? 20,
    arrowGap: args.spacing?.arrowGap ?? DEFAULT_GAP,
  };
  const arrowGap = spacing.arrowGap;

  // Route to edges-only handler
  if (args.mode === 'edges-only') {
    return handleEdgesOnly(args, spacing);
  }

  // layout mode requires algorithm
  if (!args.algorithm) {
    throw new Error('algorithm is required when mode is "layout" (or mode is omitted)');
  }

  // Phase 1: fetch and validate
  let elements = await fetchAllElements();
  if (args.elementIds && args.elementIds.length > 0) {
    const idSet = new Set(args.elementIds);
    elements = elements.filter(e => idSet.has(e.id));
  }

  const elementMap = new Map(elements.map(e => [e.id, e]));

  // Check for duplicate node IDs
  const seenNodeIds = new Set<string>();
  for (const node of args.nodes) {
    if (seenNodeIds.has(node.id)) throw new Error(`Duplicate node id in nodes[]: ${node.id}`);
    seenNodeIds.add(node.id);
  }

  for (const node of args.nodes) {
    if (!elementMap.has(node.id)) throw new Error(`Node not found on canvas: ${node.id}`);
    if (node.parentId && node.parentId === node.id) {
      throw new Error(`Node "${node.id}" has parentId pointing to itself`);
    }
    if (node.parentId && !args.nodes.some(n => n.id === node.parentId)) {
      throw new Error(`parentId "${node.parentId}" for node "${node.id}" is not in nodes[]`);
    }
  }

  // Detect cycles in the parentId chain (would cause infinite recursion in runDagreLayout)
  function parentChainHasCycle(startId: string): boolean {
    const visited = new Set<string>();
    let current: string | undefined = startId;
    while (current) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = args.nodes.find(n => n.id === current)?.parentId;
    }
    return false;
  }
  for (const node of args.nodes) {
    if (node.parentId && parentChainHasCycle(node.id)) {
      throw new Error(`Cycle detected in parentId chain for node "${node.id}"`);
    }
  }

  // Cycle detection for flow mode
  if (args.algorithm === 'flow') {
    const cycle = detectCycle(args.nodes, args.edges);
    if (cycle) throw new Error(cycle);
  }

  // Validate groups (layout mode only — ignored in edges-only which was handled above)
  if (args.groups && args.groups.length > 0) {
    const memberGroupMap = new Map<string, string>();
    const nodeWithParent = new Set(args.nodes.filter(n => n.parentId).map(n => n.id));
    for (const group of args.groups) {
      if (!Number.isInteger(group.rank) || group.rank < 0) {
        throw new Error(`groups: rank must be a non-negative integer (got ${group.rank} in group "${group.id}")`);
      }
      if (group.memberIds.length === 0) {
        throw new Error(`groups: group "${group.id}" has empty memberIds`);
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

  // Apply zone y-snap if groups are provided
  if (args.groups && args.groups.length > 0) {
    applyGroupsYSnap(positions, args.groups, nodesWithSize, spacing.rankSep);
  }

  // Phase 4: route arrows
  const allElements = await fetchAllElements(); // re-fetch for fresh obstacle list
  const posMap = new Map(positions.map(p => [p.id, p]));

  const arrowUpdates: (Partial<CanvasElement> & { id: string })[] = [];

  // Track accumulated boundElements updates — merge per element to avoid write-after-write
  const boundElementsAccum = new Map<string, { type: string; id: string }[]>();
  function accumulateBound(el: CanvasElement, arrowId: string): void {
    const current = boundElementsAccum.get(el.id) ?? [...(el.boundElements || [])];
    if (!current.some(b => b.id === arrowId)) {
      current.push({ type: 'arrow', id: arrowId });
    }
    boundElementsAccum.set(el.id, current);
  }

  const layoutNodeIds = new Set(args.nodes.map(n => n.id));

  const routingSummary = {
    totalEdges: args.edges.length,
    clean: 0,
    withCrossings: 0,
    edges: [] as { fromId: string; toId: string; crossings: number; type: string }[],
  };

  const routedEdgesAL: RoutedEdge[] = [];

  for (const edge of args.edges) {
    const fromPos = posMap.get(edge.fromId);
    const toPos   = posMap.get(edge.toId);
    if (!fromPos || !toPos) continue;

    const obstacles = allElements
      .filter(e => e.id !== edge.fromId && e.id !== edge.toId && e.type !== 'arrow' && e.width && e.height)
      .map(e => {
        const pos = posMap.get(e.id);
        return pos
          ? { x: pos.x, y: pos.y, width: pos.width, height: pos.height }
          : { x: e.x, y: e.y, width: e.width!, height: e.height! };
      });

    const applyFlowDirection: 'TB' | 'LR' = args.direction === 'left-right' ? 'LR' : 'TB';
    const { points, elbowed, fromPt, crossings: edgeCrossings, routeType: edgeRouteType, exitSide, entrySide, laneAxis, laneCoord } = routeArrow(fromPos, toPos, obstacles, { gap: arrowGap, flowDirection: applyFlowDirection });
    if (edgeCrossings > 0) {
      routingSummary.withCrossings++;
      routingSummary.edges.push({ fromId: edge.fromId, toId: edge.toId, crossings: edgeCrossings, type: edgeRouteType });
    } else {
      routingSummary.clean++;
    }

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
        start: { id: edge.fromId, gap: DEFAULT_GAP },
        end:   { id: edge.toId,   gap: DEFAULT_GAP },
        strokeColor: '#1e1e1e',
        strokeStyle: 'solid',
        startArrowhead: null,
        endArrowhead: 'arrow',
      };
      await postElement(newArrow); // Sequential: arrowId must be captured per-iteration for boundElements wiring
      arrowId = newArrow.id;
    } else {
      arrowUpdates.push({ id: arrowId, x: fromPt[0], y: fromPt[1], points: points as [number, number][], elbowed });
    }

    routedEdgesAL.push({
      arrowId: arrowId!,
      fromId: edge.fromId,
      toId: edge.toId,
      entrySide,
      exitSide,
      fromPt,
      points: points as Point[],
      elbowed,
      laneAxis,
      laneCoord,
    });

    // Accumulate boundElements (merged per element to avoid write-after-write)
    const fromEl = allElements.find(e => e.id === edge.fromId);
    const toEl   = allElements.find(e => e.id === edge.toId);
    if (fromEl) accumulateBound(fromEl, arrowId);
    if (toEl)   accumulateBound(toEl,   arrowId);
  }

  // Fan-out post-pass: spread arrows sharing the same (targetId, entrySide)
  const targetGroupsAL = new Map<string, RoutedEdge[]>();
  for (const re of routedEdgesAL) {
    const key = `${re.toId}:${re.entrySide}`;
    const group = targetGroupsAL.get(key) ?? [];
    group.push(re);
    targetGroupsAL.set(key, group);
  }

  for (const [, group] of targetGroupsAL) {
    if (group.length <= 1) continue;
    const toId = group[0]!.toId;
    const toPosEntry = posMap.get(toId);
    const toElFallback = elementMap.get(toId);
    const toElPos = toPosEntry ?? toElFallback;
    if (!toElPos) continue;
    const toBox: Box = { x: toElPos.x, y: toElPos.y, width: toElPos.width || 100, height: toElPos.height || 60 };

    // Sort by source position for spatial coherence
    const entrySide = group[0]!.entrySide;
    group.sort((a, b) => {
      const aPosEntry = posMap.get(a.fromId);
      const aElFallback = elementMap.get(a.fromId);
      const aEl = aPosEntry ?? aElFallback;
      const bPosEntry = posMap.get(b.fromId);
      const bElFallback = elementMap.get(b.fromId);
      const bEl = bPosEntry ?? bElFallback;
      if (!aEl || !bEl) return 0;
      return (entrySide === 'top' || entrySide === 'bottom')
        ? aEl.x - bEl.x
        : aEl.y - bEl.y;
    });

    const focusValues = computeFanOut(group.length);
    for (let i = 0; i < group.length; i++) {
      const re = group[i]!;
      const focus = focusValues[i]!;
      const fromPosEntry = posMap.get(re.fromId);
      const fromElFallback = elementMap.get(re.fromId);
      const fromElPos = fromPosEntry ?? fromElFallback;
      if (!fromElPos) continue;
      const fromBox: Box = { x: fromElPos.x, y: fromElPos.y, width: fromElPos.width || 100, height: fromElPos.height || 60 };

      const fanObstacles = allElements
        .filter(e => e.id !== re.fromId && e.id !== re.toId && e.type !== 'arrow' && e.width && e.height)
        .map(e => {
          const pos = posMap.get(e.id);
          return pos
            ? { x: pos.x, y: pos.y, width: pos.width, height: pos.height }
            : { x: e.x, y: e.y, width: e.width!, height: e.height! };
        });

      const rerouted = routeArrow(fromBox, toBox, fanObstacles, {
        gap: DEFAULT_GAP,
        endFocus: focus,
        entrySide: re.entrySide,
      });

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

  // Lane consolidation
  const laneGroupsAL = new Map<string, { arrowId: string; laneCoord: number; laneAxis: 'x' | 'y' }[]>();
  for (const re of routedEdgesAL) {
    if (re.laneCoord !== undefined && re.laneAxis) {
      const key = `${re.exitSide}:${re.laneAxis}`;
      const group = laneGroupsAL.get(key) ?? [];
      group.push({ arrowId: re.arrowId, laneCoord: re.laneCoord, laneAxis: re.laneAxis });
      laneGroupsAL.set(key, group);
    }
  }

  const allObstaclesAL = allElements
    .filter(e => e.type !== 'arrow' && e.width && e.height)
    .map(e => ({ x: e.x, y: e.y, width: e.width!, height: e.height! }));

  for (const [, group] of laneGroupsAL) {
    if (group.length <= 1) continue;
    const coords = group.map(g => g.laneCoord);
    const axis = group[0]!.laneAxis;
    snapLanes(coords, LANE_SNAP_THRESHOLD, allObstaclesAL, axis);
    // Lane snapping computed — integration with re-routing left as future work
  }

  // Write node positions + arrow updates in parallel
  const nodeUpdates = positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height }));

  await Promise.all([
    ...nodeUpdates.map(u => putElement(u)),
    ...arrowUpdates.map(u => putElement(u)),
    ...[...boundElementsAccum.entries()].map(([id, boundElements]) => putElement({ id, boundElements })),
  ]);

  return {
    updated: nodeUpdates.length + arrowUpdates.length,
    positions: positions.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height })),
    routingSummary,
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
        algorithm: { type: 'string', enum: ['hierarchical', 'flow'], description: 'Layout algorithm (required when mode is "layout"). hierarchical: Sugiyama layered tree. flow: DAG pipeline — cycles are an error.' },
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
            arrowGap: { type: 'number', description: 'Pixel gap between arrowheads and element edges (default 8)' },
          },
        },
        mode: {
          type: 'string',
          enum: ['layout', 'edges-only'],
          description: 'layout (default): run Dagre and reposition nodes. edges-only: skip Dagre, route only the arrows in edges[] using current element positions — nodes are not moved.',
        },
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
      },
      required: ['nodes', 'edges'],
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
    description: 'Create a routed arrow between two existing elements. Routes automatically in three tiers: straight if the path is clear, elbow (single bend) if one turn suffices, lane if the arrow must navigate around a cluster of elements by finding the gap between columns or rows. Check routing.crossings in the response — if > 0, the route still crosses elements and you should use batch_create_elements with explicit waypoints instead. Returns the arrow ID for use in apply_layout edges. Note: text content passed as "text" during element creation (via create_element or batch_create_elements) is stored and returned as "label.text" — this is expected and the text renders correctly inside the shape.',
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
        startFocus: { type: 'number', description: 'Pin start attachment position along element edge (-1 to 1)' },
        endFocus: { type: 'number', description: 'Pin end attachment position along element edge (-1 to 1)' },
        gap: { type: 'number', description: 'Pixel gap between arrowhead and element boundary (default 8)' },
        flowDirection: { type: 'string', enum: ['TB', 'LR'], description: 'Bias routing for top-down or left-right flow' },
        preferSide: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], description: 'Hint which side to exit from' },
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
