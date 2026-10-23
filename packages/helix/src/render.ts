import { COLORS } from "./colors";
import { RADIUS, ROW_GAP, phaseAt, strandDepth, strandX, visibleRange } from "./layout";
import type { HelixLayout, HelixNode, GraphPoint } from "./layout";

export interface View {
  w: number;
  h: number;
}

const TAU = Math.PI * 2;

/** Screen position of a helix node. */
export function helixPos(n: HelixNode, view: View, scrollY: number) {
  return { x: view.w / 2 + strandX(n.y, n.strand), y: n.y - scrollY };
}

const shortTitle = (s: string) => (s.length > 28 ? s.slice(0, 27) + "…" : s);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface HelixDrawState {
  layout: HelixLayout;
  scrollY: number;
  selected: string | null;
  hover: string | null;
  proposed: Set<string>;
  neighbours: Set<string>;
}

export function drawHelix(ctx: CanvasRenderingContext2D, view: View, s: HelixDrawState) {
  const { w, h } = view;
  const cx = w / 2;
  const top = s.scrollY - 40;
  const bottom = s.scrollY + h + 40;
  const [first, last] = visibleRange(s.layout.nodes.length, top, bottom, 1);

  // Backbone: back halves first and thinner, front halves on top.
  const yEnd = Math.min(bottom, s.layout.height);
  for (const front of [false, true]) {
    for (const strand of [0, 1] as const) {
      ctx.beginPath();
      let pen = false;
      for (let y = Math.max(0, top); y <= yEnd; y += 5) {
        const isFront = strandDepth(y, strand) >= 0;
        if (isFront !== front) {
          pen = false;
          continue;
        }
        const x = cx + strandX(y, strand);
        if (pen) ctx.lineTo(x, y - s.scrollY);
        else ctx.moveTo(x, y - s.scrollY);
        pen = true;
      }
      ctx.strokeStyle = COLORS.strand[strand];
      ctx.globalAlpha = front ? 0.85 : 0.3;
      ctx.lineWidth = front ? 3 : 1.5;
      ctx.stroke();
    }
  }

  // Rungs: wikilinks as DNA base pairs. Dim unless they touch the selection.
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = 0.28;
  const hot: [HelixNode, HelixNode][] = [];
  ctx.beginPath();
  for (const r of s.layout.rungs) {
    const [a, b] = r;
    if (Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
    if (a.note.path === s.selected || b.note.path === s.selected) {
      hot.push(r);
      continue;
    }
    rungPath(ctx, a, b, cx, s.scrollY);
  }
  ctx.stroke();
  if (hot.length) {
    ctx.beginPath();
    for (const [a, b] of hot) rungPath(ctx, a, b, cx, s.scrollY);
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Nodes + labels
  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
  ctx.textBaseline = "middle";
  for (let i = first; i <= last; i++) {
    const n = s.layout.nodes[i];
    const { x, y } = helixPos(n, view, s.scrollY);
    const depth = strandDepth(n.y, n.strand);
    const p = n.note.path;
    const isSel = p === s.selected;
    const dim = s.selected && !isSel && !s.neighbours.has(p);
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.beginPath();
    ctx.arc(x, y, 5 + depth * 1.5, 0, TAU);
    ctx.fillStyle = COLORS.strand[n.strand];
    ctx.fill();
    if (s.proposed.has(p)) ring(ctx, x, y, 9, COLORS.gold, 2);
    if (isSel || p === s.hover) ring(ctx, x, y, s.proposed.has(p) ? 13 : 9, COLORS.select, 2);
    ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
    ctx.globalAlpha = (dim ? 0.3 : 0.55) + (depth + 1) * 0.2;
    const right = x >= cx;
    ctx.textAlign = right ? "left" : "right";
    ctx.fillText(shortTitle(n.note.title), x + (right ? 16 : -16), y);
    if (i % 4 === 0) {
      ctx.textAlign = "left";
      ctx.fillStyle = COLORS.muted;
      ctx.globalAlpha = 0.9;
      ctx.fillText(day(n.note.mtime), 12, y);
    }
  }
  ctx.globalAlpha = 1;

  if (s.layout.nodes.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "right";
    ctx.fillText(s.scrollY < 20 ? "▲ newest" : "▲ newer", w - 12, 16);
    ctx.fillText("▼ older", w - 12, h - 12);
  }
}

function rungPath(ctx: CanvasRenderingContext2D, a: HelixNode, b: HelixNode, cx: number, scrollY: number) {
  const ax = cx + strandX(a.y, a.strand);
  const bx = cx + strandX(b.y, b.strand);
  ctx.moveTo(ax, a.y - scrollY);
  // Control point on the helix axis: neighbouring rows read as straight rungs, distant links bow through the core.
  ctx.quadraticCurveTo(cx, (a.y + b.y) / 2 - scrollY, bx, b.y - scrollY);
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** The collapsed mark: a short static helix with a few rungs. */
export function drawEmblem(ctx: CanvasRenderingContext2D, view: View, scale: number, alpha: number) {
  const h = Math.min(view.h * 0.5, 260) * scale;
  const cx = view.w / 2;
  const top = view.h / 2 - h / 2;
  const R = (h / 260) * 38;
  const turns = 2.5;
  ctx.globalAlpha = alpha;
  for (const front of [false, true]) {
    for (const strand of [0, 1]) {
      ctx.beginPath();
      let pen = false;
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const ph = t * turns * TAU + strand * Math.PI;
        if (Math.cos(ph) >= 0 !== front) {
          pen = false;
          continue;
        }
        const x = cx + R * Math.sin(ph);
        const y = top + t * h;
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.strokeStyle = COLORS.strand[strand];
      ctx.lineWidth = (front ? 4 : 2) * scale;
      ctx.globalAlpha = alpha * (front ? 1 : 0.4);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = alpha * 0.5;
  ctx.strokeStyle = COLORS.rung;
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    const ph = t * turns * TAU;
    ctx.moveTo(cx + R * Math.sin(ph), top + t * h);
    ctx.lineTo(cx - R * Math.sin(ph), top + t * h);
  }
  ctx.stroke();
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
  ctx.globalAlpha = 0.35;
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
  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const [path, p] of s.pts) {
    const { x, y } = graphToScreen(view, s.gv, p);
    if (x < -20 || y < -20 || x > view.w + 20 || y > view.h + 20) continue;
    const isSel = path === s.selected;
    const dim = s.selected && !isSel && !s.neighbours.has(path);
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, TAU);
    ctx.fillStyle = COLORS.strand[0];
    ctx.fill();
    if (s.proposed.has(path)) ring(ctx, x, y, 9, COLORS.gold, 2);
    if (isSel || path === s.hover) ring(ctx, x, y, s.proposed.has(path) ? 13 : 9, COLORS.select, 2);
    if (s.gv.zoom >= 0.9 || isSel || path === s.hover || s.neighbours.has(path)) {
      ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
      ctx.globalAlpha = dim ? 0.3 : 0.85;
      ctx.fillText(shortTitle(s.titles.get(path) || path), x + 11, y);
    }
  }
  ctx.globalAlpha = 1;
}

export { RADIUS, ROW_GAP, phaseAt };
