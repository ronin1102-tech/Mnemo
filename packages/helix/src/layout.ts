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
 * Vertical time axis: newest notes at the top, oldest at the bottom. Rows are
 * spaced by rank rather than clock time so a burst of notes on one day never
 * overlaps. Strands alternate so the helix reads as two interleaved timelines.
 */
export function layoutHelix(data: GraphData): HelixLayout {
  const sorted = data.nodes.slice().sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const nodes = sorted.map((note, index): HelixNode => ({ note, index, strand: (index % 2) as 0 | 1, y: PAD + index * ROW_GAP }));
  const byPath = new Map(nodes.map((n) => [n.note.path, n]));
  const seen = new Set<string>();
  const rungs: [HelixNode, HelixNode][] = [];
  for (const l of data.links) {
    const a = byPath.get(l.src);
    const b = byPath.get(l.dst);
    if (!a || !b || a === b) continue;
    const key = a.index < b.index ? a.index + ":" + b.index : b.index + ":" + a.index;
    if (seen.has(key)) continue;
    seen.add(key);
    rungs.push([a, b]);
  }
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
