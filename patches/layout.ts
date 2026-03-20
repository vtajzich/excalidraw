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
