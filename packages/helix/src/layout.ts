import type { GraphData, Link, NoteNode } from "./types";

export const ROW_GAP = 36;
export const RADIUS = 70;
/** Rows per full helix turn. */
export const TURN_ROWS = 10;
/** Height reserved under the oldest note for the spring (the pool the coil rises out of). */
export const POOL_H = 150;
const PAD = 60;

export interface HelixNode {
  note: NoteNode;
  index: number; // 0 = newest
  strand: 0 | 1;
  /** Distance up the coil from the spring. Stable: adding newer notes never changes it. */
  d: number;
  /** World y (top-origin) for the current vault size. */
  y: number;
}

export interface HelixLayout {
  nodes: HelixNode[];
  byPath: Map<string, HelixNode>;
  /** Links with both endpoints present, de-duplicated and undirected. */
  rungs: [HelixNode, HelixNode][];
  height: number;
  /** World y of d = 0 (the oldest note's row). */
  baseY: number;
  /** World y of the centre of the pool. */
  poolY: number;
}

/** The time a note sits at on the axis: frontmatter `created` when present, else modified time. */
export const timeOf = (n: NoteNode) => (typeof n.created === "number" ? n.created : n.mtime);

/**
 * Pick a strand per note so the strongest link partner sits on the opposite strand
 * (links become rungs). Notes are placed oldest-first and look only at already-placed
 * (older) notes, so adding a newer note never changes any existing note's strand.
 * `index` 0 is the newest note; edges are index pairs.
 * Strongest partner = most neighbours in common, then the most recent.
 */
export function assignStrands(count: number, edges: [number, number][]): (0 | 1)[] {
  const adj: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (const [a, b] of edges) {
    adj[a].add(b);
    adj[b].add(a);
  }
  const strand: (0 | 1)[] = new Array(count).fill(0);
  const size = [0, 0];
  for (let i = count - 1; i >= 0; i--) {
    let best = -1;
    let bestW = -1;
    for (const j of adj[i]) {
      if (j <= i) continue; // not placed yet (newer)
      let w = 1;
      for (const k of adj[i]) if (k !== j && adj[j].has(k)) w++;
      if (w > bestW || (w === bestW && j < best)) {
        best = j;
        bestW = w;
      }
    }
    strand[i] = best >= 0 ? ((1 - strand[best]) as 0 | 1) : size[0] <= size[1] ? 0 : 1;
    size[strand[i]]++;
  }
  return strand;
}

/**
 * Vertical time axis: oldest at the bottom (nearest the spring), newest at the top.
 * Rows are spaced by rank, not clock time, so a burst of notes never overlaps.
 * Everything is measured from the spring, so adding notes only extends the coil upward.
 */
export function layoutHelix(data: GraphData): HelixLayout {
  const sorted = data.nodes.slice().sort((a, b) => timeOf(b) - timeOf(a) || a.path.localeCompare(b.path));
  const idx = new Map(sorted.map((n, i) => [n.path, i]));
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const l of data.links) {
    const a = idx.get(l.src);
    const b = idx.get(l.dst);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a + ":" + b : b + ":" + a;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  const n = sorted.length;
  const strands = assignStrands(n, pairs);
  const height = PAD * 2 + Math.max(0, n - 1) * ROW_GAP + POOL_H;
  const baseY = height - POOL_H - PAD;
  const nodes = sorted.map((note, index): HelixNode => {
    const d = (n - 1 - index) * ROW_GAP;
    return { note, index, strand: strands[index], d, y: baseY - d };
  });
  const byPath = new Map(nodes.map((nd) => [nd.note.path, nd]));
  const rungs = pairs.map(([a, b]): [HelixNode, HelixNode] => [nodes[a], nodes[b]]);
  return { nodes, byPath, rungs, height, baseY, poolY: height - POOL_H * 0.4 };
}

/** Phase angle of the helix at distance d from the spring. */
export const phaseAt = (d: number) => (2 * Math.PI * d) / (TURN_ROWS * ROW_GAP);

/** Coil radius at distance d: full above the oldest note, narrowing into the pool below it. */
export const radiusAt = (d: number, drop = PAD + POOL_H * 0.6) => (d >= 0 ? RADIUS : RADIUS * Math.max(0.08, 1 + d / drop));

/** Horizontal offset from the helix axis for a strand at distance d. */
export const strandX = (d: number, strand: 0 | 1) => radiusAt(d) * Math.sin(phaseAt(d) + strand * Math.PI);

/** Depth in [-1,1]: positive means the strand is currently in front. */
export const strandDepth = (d: number, strand: 0 | 1) => Math.cos(phaseAt(d) + strand * Math.PI);

/** Index range of nodes whose rows intersect [top, bottom] in world y, capped to `cap` rendered nodes. */
export function visibleRange(layout: HelixLayout, top: number, bottom: number, margin = 2, cap = 1000): [number, number] {
  const count = layout.nodes.length;
  const first = Math.max(0, Math.floor((top - PAD) / ROW_GAP) - margin);
  const last = Math.min(count - 1, Math.ceil((bottom - PAD) / ROW_GAP) + margin, first + cap - 1);
  return [first, last];
}

/** Nodes within `depth` link-hops of `path` (including itself). */
export function withinHops(adj: Map<string, Set<string>>, path: string, depth: number): Set<string> {
  const seen = new Set<string>([path]);
  let frontier = [path];
  for (let h = 0; h < depth; h++) {
    const next: string[] = [];
    for (const p of frontier) for (const q of adj.get(p) || []) if (!seen.has(q)) { seen.add(q); next.push(q); }
    frontier = next;
  }
  return seen;
}

export interface GraphPoint {
  path: string;
  x: number;
  y: number;
}

/** Above this many notes the O(n^2) force simulation is skipped (it took ~12 s at 10k notes). */
export const FORCE_LAYOUT_MAX = 2000;

/**
 * Deterministic layout for the read-only graph mode. Small vaults get a force simulation.
 * Large ones get a sunflower (phyllotaxis) spiral in time order, newest at the centre, relaxed
 * by a few edge-attraction passes: O(n + links), so opening Graph mode stays instant at 10k notes.
 */
export function layoutGraph(nodes: NoteNode[], links: Link[]): Map<string, GraphPoint> {
  const n = nodes.length;
  if (n > FORCE_LAYOUT_MAX) return layoutSpiral(nodes, links);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts: GraphPoint[] = nodes.map((nd) => ({ path: nd.path, x: (rnd() - 0.5) * 400, y: (rnd() - 0.5) * 400 }));
  const idx = new Map(pts.map((p, i) => [p.path, i]));
  const edges: [number, number][] = [];
  for (const l of links) {
    const a = idx.get(l.src);
    const b = idx.get(l.dst);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  const iterations = Math.max(30, Math.min(300, Math.floor(3e7 / Math.max(1, n * n))));
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pts[i].x - pts[j].x;
        let dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = 1800 / d2;
        const d = Math.sqrt(d2);
        dx = (dx / d) * f;
        dy = (dy / d) * f;
        vx[i] += dx; vy[i] += dy; vx[j] -= dx; vy[j] -= dy;
      }
      vx[i] -= pts[i].x * 0.01; // gentle gravity keeps islands in view
      vy[i] -= pts[i].y * 0.01;
    }
    for (const [a, b] of edges) {
      const dx = pts[b].x - pts[a].x;
      const dy = pts[b].y - pts[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 70) * 0.05;
      vx[a] += (dx / d) * f; vy[a] += (dy / d) * f; vx[b] -= (dx / d) * f; vy[b] -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      pts[i].x += Math.max(-20, Math.min(20, vx[i])) * cool;
      pts[i].y += Math.max(-20, Math.min(20, vy[i])) * cool;
      vx[i] *= 0.5; vy[i] *= 0.5;
    }
  }
  return new Map(pts.map((p) => [p.path, p]));
}

function layoutSpiral(nodes: NoteNode[], links: Link[]): Map<string, GraphPoint> {
  const order = nodes.slice().sort((a, b) => timeOf(b) - timeOf(a) || a.path.localeCompare(b.path));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts = order.map((nd, i) => ({ path: nd.path, x: 14 * Math.sqrt(i) * Math.cos(i * golden), y: 14 * Math.sqrt(i) * Math.sin(i * golden) }));
  const idx = new Map(pts.map((p, i) => [p.path, i]));
  for (let pass = 0; pass < 3; pass++) {
    for (const l of links) {
      const a = idx.get(l.src);
      const b = idx.get(l.dst);
      if (a === undefined || b === undefined || a === b) continue;
      const dx = (pts[b].x - pts[a].x) * 0.05;
      const dy = (pts[b].y - pts[a].y) * 0.05;
      pts[a].x += dx; pts[a].y += dy; pts[b].x -= dx; pts[b].y -= dy;
    }
  }
  return new Map(pts.map((p) => [p.path, p]));
}
