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

  // Pick fewer intersections; tiebreak: prefer horizontal-first (A)
  let chosen = candidateA;
  if (countB < countA) {
    chosen = candidateB;
  }
  // else: equal intersections — horizontal-first is preferred (candidateA already chosen)

  // Convert to relative coordinates
  const origin = chosen[0];
  return {
    points: chosen.map(p => [p[0] - origin[0], p[1] - origin[1]] as Point),
    elbowed: true,
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
