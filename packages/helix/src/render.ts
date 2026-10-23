import { COLORS } from "./colors";
import { POOL_H, ROW_GAP, radiusAt, phaseAt, strandDepth, strandX, timeOf, visibleRange } from "./layout";
import type { GraphPoint, HelixLayout, HelixNode } from "./layout";

export interface View {
  w: number;
  h: number;
}

const TAU = Math.PI * 2;
const FONT = "12px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

/** Screen position of a helix node. */
export function helixPos(n: HelixNode, view: View, scrollY: number) {
  return { x: view.w / 2 + strandX(n.d, n.strand), y: n.y - scrollY };
}

const shortTitle = (s: string) => (s.length > 28 ? s.slice(0, 27) + "…" : s);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The spring: concentric ripples. Static, so an idle page costs nothing. */
function drawPool(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, alpha: number) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.water;
  for (let k = 0; k < 14; k++) {
    const t = (k + 1) / 14;
    ctx.globalAlpha = alpha * (0.9 - t * 0.75);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * t, rx * t * 0.24, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = alpha * 0.12;
  ctx.fillStyle = COLORS.water;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, rx * 0.24, 0, 0, TAU);
  ctx.fill();
}

export const poolHit = (view: View, layout: HelixLayout, scrollY: number, px: number, py: number) => {
  const dx = (px - view.w / 2) / 170;
  const dy = (py - (layout.poolY - scrollY)) / 46;
  return dx * dx + dy * dy <= 1;
};

/** One strand as glass: a wide faint body with a bright core. `front` selects the half in front. */
function strandPath(ctx: CanvasRenderingContext2D, cx: number, strand: 0 | 1, front: boolean, y0: number, y1: number, toScreen: (y: number) => number, baseY: number) {
  ctx.beginPath();
  let pen = false;
  for (let y = y0; y <= y1; y += 5) {
    const d = baseY - y;
    if ((strandDepth(d, strand) >= 0) !== front) {
      pen = false;
      continue;
    }
    const x = cx + strandX(d, strand);
    if (pen) ctx.lineTo(x, toScreen(y));
    else ctx.moveTo(x, toScreen(y));
    pen = true;
  }
}

function strokeGlass(ctx: CanvasRenderingContext2D, strand: 0 | 1, front: boolean, alpha: number) {
  ctx.strokeStyle = COLORS.strand[strand];
  ctx.lineCap = "round";
  ctx.globalAlpha = alpha * (front ? 0.22 : 0.1);
  ctx.lineWidth = front ? 9 : 5;
  ctx.stroke();
  ctx.globalAlpha = alpha * (front ? 0.95 : 0.4);
  ctx.lineWidth = front ? 2.4 : 1.4;
  ctx.stroke();
}

export interface HelixDrawState {
  layout: HelixLayout;
  scrollY: number;
  selected: string | null;
  hover: string | null;
  proposed: Set<string>;
  /** Notes within the focus depth of the selection. */
  neighbours: Set<string>;
  /** 0..1 rising-transition progress; 1 when settled. */
  reveal: number;
  alpha: number;
}

export function drawHelix(ctx: CanvasRenderingContext2D, view: View, s: HelixDrawState) {
  const { w, h } = view;
  const L = s.layout;
  const cx = w / 2;
  const lift = (1 - s.reveal) * 60; // the coil rises out of the water
  const toScreen = (y: number) => y - s.scrollY + lift;
  const top = s.scrollY - 40;
  const bottom = s.scrollY + h + 40;
  const [first, last] = visibleRange(L, top, bottom, 1);
  const A = s.alpha;
  ctx.font = FONT;

  if (L.poolY > top - 60 && L.poolY < bottom + 60) drawPool(ctx, cx, L.poolY - s.scrollY, 170, A);

  const y0 = Math.max(0, top);
  const y1 = Math.min(bottom, L.poolY);
  for (const front of [false, true]) {
    for (const strand of [0, 1] as const) {
      strandPath(ctx, cx, strand, front, y0, y1, toScreen, L.baseY);
      strokeGlass(ctx, strand, front, A * Math.min(1, s.reveal * 2));
    }
  }

  // Rungs (links). Quiet blue-white, bright only when they touch the selection.
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = A * 0.3 * s.reveal;
  const hot: [HelixNode, HelixNode][] = [];
  ctx.beginPath();
  for (const r of L.rungs) {
    const [a, b] = r;
    if (Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
    if (s.selected && (a.note.path === s.selected || b.note.path === s.selected)) hot.push(r);
    else rungPath(ctx, a, b, cx, toScreen);
  }
  ctx.stroke();
  if (hot.length) {
    ctx.beginPath();
    for (const [a, b] of hot) rungPath(ctx, a, b, cx, toScreen);
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = A * 0.95;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.textBaseline = "middle";
  const span = Math.max(1, last - first + 1);
  for (let i = first; i <= last; i++) {
    const n = L.nodes[i];
    const x = cx + strandX(n.d, n.strand);
    const y = toScreen(n.y);
    const depth = strandDepth(n.d, n.strand);
    const p = n.note.path;
    const isSel = p === s.selected;
    const dim = s.selected && !s.neighbours.has(p);
    // nodes light in sequence from the water upward while rising
    const lit = Math.max(0, Math.min(1, s.reveal * 1.6 - ((last - i) / span) * 0.6));
    const a = A * lit * (dim ? 0.3 : 1);
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, 4.5 + depth * 1.5, 0, TAU);
    ctx.fillStyle = COLORS.node;
    ctx.fill();
    ring(ctx, x, y, 6.5 + depth * 1.5, COLORS.strand[n.strand], 1.2);
    if (s.proposed.has(p)) ring(ctx, x, y, 10, COLORS.gold, 2.2);
    if (isSel || p === s.hover) ring(ctx, x, y, s.proposed.has(p) ? 14 : 10, COLORS.select, 2);
    ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
    ctx.globalAlpha = a * (0.55 + (depth + 1) * 0.2);
    const right = x >= cx;
    ctx.textAlign = right ? "left" : "right";
    ctx.fillText(shortTitle(n.note.title), x + (right ? 16 : -16), y);
    if (i % 4 === 0) {
      ctx.textAlign = "left";
      ctx.fillStyle = COLORS.muted;
      ctx.globalAlpha = a * 0.9;
      ctx.fillText(day(timeOf(n.note)), 12, y);
    }
  }
  ctx.globalAlpha = A;
  if (L.nodes.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "right";
    ctx.fillText(s.scrollY < 20 ? "▲ newest" : "▲ newer", w - 12, 16);
    ctx.fillText("▼ the spring (oldest)", w - 12, h - 12);
  }
  ctx.globalAlpha = 1;
}

function rungPath(ctx: CanvasRenderingContext2D, a: HelixNode, b: HelixNode, cx: number, toScreen: (y: number) => number) {
  ctx.moveTo(cx + strandX(a.d, a.strand), toScreen(a.y));
  // Control point on the helix axis: neighbouring rows read as straight rungs, distant links bow through the core.
  ctx.quadraticCurveTo(cx, (toScreen(a.y) + toScreen(b.y)) / 2, cx + strandX(b.d, b.strand), toScreen(b.y));
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * The mark itself: gold ring, water-blue coil rising out of the spring, gold beads on one
 * strand, quiet rungs. A branding surface (emblem mode only), so it may use MARK_GOLD.
 */
export function drawEmblem(ctx: CanvasRenderingContext2D, view: View, scale: number, alpha: number) {
  const cx = view.w / 2;
  const cy = view.h / 2;
  const R = Math.min(view.w, view.h) * 0.44 * scale;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLORS.markGold;
  for (const [k, lw, a] of [[1, 2, 0.9], [0.955, 1, 0.7], [0.88, 1, 0.35]] as const) {
    ctx.globalAlpha = alpha * a;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, R * k, 0, TAU);
    ctx.stroke();
  }
  ctx.setLineDash([1, 5]);
  ctx.globalAlpha = alpha * 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.915, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  const poolCy = cy + R * 0.52;
  drawPool(ctx, cx, poolCy, R * 0.62, alpha);

  const h = R * 1.15;
  const baseY = poolCy;
  const turns = 2.4;
  const rad = R * 0.14;
  const at = (t: number, strand: number) => {
    const ph = t * turns * TAU + strand * Math.PI;
    const taper = Math.min(1, t * 5 + 0.08); // narrows into the water
    return { x: cx + rad * taper * Math.sin(ph), y: baseY - t * h, front: Math.cos(ph) >= 0 };
  };
  for (const front of [false, true]) {
    for (let strand = 0; strand < 2; strand++) {
      ctx.beginPath();
      let pen = false;
      for (let t = 0; t <= 1.0001; t += 0.008) {
        const p = at(t, strand);
        if (p.front !== front) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        pen = true;
      }
      ctx.strokeStyle = COLORS.strand[strand];
      ctx.globalAlpha = alpha * (front ? 0.22 : 0.1);
      ctx.lineWidth = (front ? 9 : 5) * scale;
      ctx.stroke();
      ctx.globalAlpha = alpha * (front ? 0.95 : 0.4);
      ctx.lineWidth = (front ? 2.4 : 1.4) * scale;
      ctx.stroke();
    }
  }
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = alpha * 0.35;
  ctx.lineWidth = 1.2 * scale;
  ctx.beginPath();
  for (let i = 1; i < 24; i++) {
    const t = i / 24;
    const a = at(t, 0);
    const b = at(t, 1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.fillStyle = COLORS.markGold; // the beads: notes on the coil
  for (let i = 2; i < 23; i++) {
    const p = at(i / 24, 0);
    ctx.globalAlpha = alpha * (p.front ? 1 : 0.55);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (p.front ? 4.2 : 3) * scale, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export interface GraphView {
  x: number;
  y: number;
  zoom: number;
}
export interface GraphDrawState {
  pts: Map<string, GraphPoint>;
  links: { src: string; dst: string }[];
  titles: Map<string, string>;
  selected: string | null;
  hover: string | null;
  proposed: Set<string>;
  neighbours: Set<string>;
  gv: GraphView;
}

export const graphToScreen = (view: View, gv: GraphView, p: { x: number; y: number }) => ({
  x: view.w / 2 + (p.x - gv.x) * gv.zoom,
  y: view.h / 2 + (p.y - gv.y) * gv.zoom,
});

export function drawGraph(ctx: CanvasRenderingContext2D, view: View, s: GraphDrawState) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  for (const l of s.links) {
    const a = s.pts.get(l.src);
    const b = s.pts.get(l.dst);
    if (!a || !b) continue;
    const pa = graphToScreen(view, s.gv, a);
    const pb = graphToScreen(view, s.gv, b);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const [path, p] of s.pts) {
    const { x, y } = graphToScreen(view, s.gv, p);
    if (x < -20 || y < -20 || x > view.w + 20 || y > view.h + 20) continue;
    const isSel = path === s.selected;
    const dim = s.selected && !s.neighbours.has(path);
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, TAU);
    ctx.fillStyle = COLORS.node;
    ctx.fill();
    if (s.proposed.has(path)) ring(ctx, x, y, 9, COLORS.gold, 2.2);
    if (isSel || path === s.hover) ring(ctx, x, y, s.proposed.has(path) ? 13 : 9, COLORS.select, 2);
    if (s.gv.zoom >= 0.9 || isSel || path === s.hover || s.neighbours.has(path)) {
      ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
      ctx.globalAlpha = dim ? 0.3 : 0.85;
      ctx.fillText(shortTitle(s.titles.get(path) || path), x + 11, y);
    }
  }
  ctx.globalAlpha = 1;
}

export { POOL_H, ROW_GAP, radiusAt, phaseAt };
