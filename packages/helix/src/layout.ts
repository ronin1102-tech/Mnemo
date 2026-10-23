import type { GraphData, Link, NoteNode } from "./types";

export const ROW_GAP = 36;
export const RADIUS = 70;
/** Rows per full helix turn. */
export const TURN_ROWS = 10;

export interface HelixNode {
  note: NoteNode;
  index: number; // 0 = newest
  strand: 0 | 1;
  y: number; // world y; newest at 0, oldest at the bottom
}

export interface HelixLayout {
  nodes: HelixNode[];
  byPath: Map<string, HelixNode>;
  /** Links with both endpoints present, de-duplicated and undirected. */
  rungs: [HelixNode, HelixNode][];
  height: number;
}

const PAD = 60;

/**
 * Pick a strand per note so linked notes sit on opposite strands (a link becomes a rung
 * between the two strands). Most-connected notes are placed first; each later note goes
 * opposite the strand most of its already-placed neighbours are on. Ties and isolated
 * notes balance the two strands.
 */
export function assignStrands(count: number, edges: [number, number][]): (0 | 1)[] {
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => adj[b].length - adj[a].length || a - b);
  const strand: (0 | 1 | -1)[] = new Array(count).fill(-1);
  const size = [0, 0];
  const queued = new Array<boolean>(count).fill(false);
  // Place a connected component breadth-first from its most-connected note so chains alternate cleanly.
  for (const start of order) {
    if (strand[start] !== -1) continue;
    const queue = [start];
    queued[start] = true;
    for (let q = 0; q < queue.length; q++) {
      const n = queue[q];
      if (strand[n] === -1) {
        const votes = [0, 0];
        for (const m of adj[n]) if (strand[m] !== -1) votes[strand[m] as 0 | 1]++;
        // opposite the strand holding more of its neighbours; on a tie, the emptier strand
        strand[n] = votes[0] === votes[1] ? (size[0] <= size[1] ? 0 : 1) : votes[0] > votes[1] ? 1 : 0;
        size[strand[n] as 0 | 1]++;
      }
      for (const m of adj[n].slice().sort((x, y) => adj[y].length - adj[x].length || x - y)) if (!queued[m]) {
        queued[m] = true;
        queue.push(m);
      }
    }
  }
  return strand as (0 | 1)[];
}

/**
 * Vertical time axis: newest notes at the top, oldest at the bottom. Rows are spaced by
 * rank rather than clock time so a burst of notes on one day never overlaps. Strands are
 * chosen so linked notes face each other across the helix (see assignStrands).
 */
export function layoutHelix(data: GraphData): HelixLayout {
  const sorted = data.nodes.slice().sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
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
  const strands = assignStrands(sorted.length, pairs);
  const nodes = sorted.map((note, index): HelixNode => ({ note, index, strand: strands[index], y: PAD + index * ROW_GAP }));
  const byPath = new Map(nodes.map((n) => [n.note.path, n]));
  const rungs = pairs.map(([a, b]): [HelixNode, HelixNode] => [nodes[a], nodes[b]]);
  return { nodes, byPath, rungs, height: PAD * 2 + Math.max(0, nodes.length - 1) * ROW_GAP };
}

/** Phase angle of the helix at world y. */
export const phaseAt = (y: number) => (2 * Math.PI * y) / (TURN_ROWS * ROW_GAP);

/** Horizontal offset from the helix axis for a strand at world y. */
export const strandX = (y: number, strand: 0 | 1, radius = RADIUS) => radius * Math.sin(phaseAt(y) + strand * Math.PI);

/** Depth in [-1,1]: positive means the strand is currently in front. */
export const strandDepth = (y: number, strand: 0 | 1) => Math.cos(phaseAt(y) + strand * Math.PI);

/** Index range of nodes whose rows intersect [top, bottom] in world y (binary-free: rows are uniform). */
export function visibleRange(count: number, top: number, bottom: number, margin = 2): [number, number] {
  const first = Math.max(0, Math.floor((top - PAD) / ROW_GAP) - margin);
  const last = Math.min(count - 1, Math.ceil((bottom - PAD) / ROW_GAP) + margin);
  return [first, last];
}

export interface GraphPoint {
  path: string;
  x: number;
  y: number;
}

/** Deterministic force-directed layout for the read-only graph mode. */
export function layoutGraph(nodes: NoteNode[], links: Link[]): Map<string, GraphPoint> {
  const n = nodes.length;
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
