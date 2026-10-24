import { COLORS } from "./colors";
import { blit, glowSprite, hash, quadAt, withAlpha, wrap } from "./fx";
import type { TierSpec } from "./fx";
import { ROW_GAP, strandDepth, strandX, timeOf, visibleRange } from "./layout";
import type { GraphPoint, HelixLayout, HelixNode } from "./layout";

export interface View {
  w: number;
  h: number;
  /** Horizontal centre of the working view (shifts right while the focus card is open). */
  cx?: number;
}

export const centreX = (view: View) => (view.cx === undefined ? view.w / 2 : view.cx);

const TAU = Math.PI * 2;
const SANS = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
const FONT = `12px ${SANS}`;
const FONT_SEL = `600 13px ${SANS}`;

const shortTitle = (s: string) => (s.length > 30 ? s.slice(0, 29) + "…" : s);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- stage -----------------------------------------------------------------

let bgCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** Deep-navy ground with a soft central light and a vignette. Static: rendered once per size. */
export function drawBackground(ctx: CanvasRenderingContext2D, view: View, dpr: number) {
  const key = `${view.w}x${view.h}@${dpr}`;
  if (!bgCache || bgCache.key !== key) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(view.w * dpr);
    c.height = Math.ceil(view.h * dpr);
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    g.scale(dpr, dpr);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, view.w, view.h);
    const R = Math.max(view.w, view.h);
    const light = g.createRadialGradient(view.w / 2, view.h * 0.42, 0, view.w / 2, view.h * 0.42, R * 0.7);
    light.addColorStop(0, "rgba(40,78,150,0.28)");
    light.addColorStop(0.5, "rgba(18,38,92,0.12)");
    light.addColorStop(1, "rgba(5,12,36,0)");
    g.fillStyle = light;
    g.fillRect(0, 0, view.w, view.h);
    const vig = g.createRadialGradient(view.w / 2, view.h / 2, R * 0.35, view.w / 2, view.h / 2, R * 0.8);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,2,10,0.55)");
    g.fillStyle = vig;
    g.fillRect(0, 0, view.w, view.h);
    bgCache = { key, canvas: c };
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(bgCache.canvas, 0, 0, view.w, view.h);
}

/** Ambient dust: screen-space motes drifting up, with depth parallax against travel. */
export function drawDust(ctx: CanvasRenderingContext2D, view: View, t: number, count: number, travel: number, alpha: number) {
  if (!count || alpha <= 0) return;
  const s = glowSprite(COLORS.node, 0.1);
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < count; k++) {
    const depth = 0.2 + 0.8 * hash(k, 11);
    const x = wrap(hash(k, 12) * view.w + Math.sin(t * 0.13 * depth + k) * 14, view.w);
    const y = wrap(hash(k, 13) * view.h - t * (3 + 9 * depth) - travel * depth * 0.3, view.h);
    const twinkle = 0.55 + 0.45 * Math.sin(t * (0.4 + depth) + k * 2.3);
    ctx.globalAlpha = alpha * (0.06 + 0.3 * depth) * twinkle;
    blit(ctx, s, x, y, 2 + depth * 5);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

/** The spring: a lit pool with ripples spreading outward (static rings when not animating). */
export function drawWater(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, alpha: number, t: number, animate: boolean) {
  const ry = rx * 0.24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.24);
  const body = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  body.addColorStop(0, withAlpha(COLORS.water, 0.45));
  body.addColorStop(0.45, withAlpha(COLORS.water, 0.16));
  body.addColorStop(1, withAlpha(COLORS.water, 0));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.strand[0];
  const rings = 11;
  for (let k = 0; k < rings; k++) {
    const p = animate ? wrap(t * 0.11 + k / rings, 1) : (k + 1) / rings;
    ctx.globalAlpha = alpha * (1 - p) * 0.75;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * p, ry * p, 0, 0, TAU);
    ctx.stroke();
  }
  // bright eye where the coil meets the water
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha * 0.6;
  blit(ctx, glowSprite(COLORS.strand[0], 0.08), cx, cy, rx * 0.35);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// ---- helix -------------------------------------------------------------------

/** Screen position of a helix node. */
export function helixPos(n: HelixNode, view: View, scrollY: number) {
  return { x: centreX(view) + strandX(n.d, n.strand), y: n.y - scrollY };
}

export const poolHit = (view: View, layout: HelixLayout, scrollY: number, px: number, py: number) => {
  const dx = (px - centreX(view)) / 190;
  const dy = (py - (layout.poolY - scrollY)) / 50;
  return dx * dx + dy * dy <= 1;
};

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
  t: number;
  fx: TierSpec;
  /** Time (s) the current selection was made, for its spark burst. */
  selectedAt: number;
  /** A proposal on this note just settled: flash once. */
  flash?: { path: string; age: number; ok: boolean } | null;
}

function strandPath(ctx: CanvasRenderingContext2D, cx: number, strand: 0 | 1, front: boolean, y0: number, y1: number, toScreen: (y: number) => number, baseY: number) {
  ctx.beginPath();
  let pen = false;
  for (let y = y0; y <= y1; y += 4) {
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

/** Glass: a wide faint body, a coloured core and, in front, a thin specular highlight. */
function strokeGlass(ctx: CanvasRenderingContext2D, strand: 0 | 1, front: boolean, alpha: number) {
  ctx.strokeStyle = COLORS.strand[strand];
  ctx.lineCap = "round";
  ctx.globalAlpha = alpha * (front ? 0.16 : 0.07);
  ctx.lineWidth = front ? 12 : 6;
  ctx.stroke();
  ctx.globalAlpha = alpha * (front ? 0.9 : 0.35);
  ctx.lineWidth = front ? 2.6 : 1.4;
  ctx.stroke();
  if (front) {
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = COLORS.node;
    ctx.globalAlpha = alpha * 0.3;
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }
}

export function drawHelix(ctx: CanvasRenderingContext2D, view: View, s: HelixDrawState) {
  const { w, h } = view;
  const L = s.layout;
  const cx = centreX(view);
  const lift = (1 - s.reveal) * 70; // the coil rises out of the water
  const toScreen = (y: number) => y - s.scrollY + lift;
  const top = s.scrollY - 60;
  const bottom = s.scrollY + h + 60;
  const [first, last] = visibleRange(L, top, bottom, 1);
  const A = s.alpha;
  const t = s.t;

  // the spring, and motes rising from it
  if (L.poolY > top - 80 && L.poolY < bottom + 600) {
    drawWater(ctx, cx, toScreen(L.poolY), 200, A, t, s.fx.animate);
    if (s.fx.motes) {
      const mote = glowSprite(COLORS.node, 0.12);
      ctx.globalCompositeOperation = "lighter";
      for (let k = 0; k < s.fx.motes; k++) {
        const life = wrap(t * (0.04 + hash(k, 21) * 0.06) + hash(k, 22), 1);
        const y = toScreen(L.poolY) - life * 560;
        const x = cx + (hash(k, 23) - 0.5) * 150 * (0.35 + life) + Math.sin(t * 0.7 + k) * 7;
        ctx.globalAlpha = A * Math.sin(life * Math.PI) * (0.3 + 0.5 * hash(k, 24));
        blit(ctx, mote, x, y, 4 + hash(k, 25) * 8);
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // time rail in the left gutter (only where there is room beside the coil's labels)
  const railX = w >= 640 ? 96 : 0;
  ctx.font = `11px ${SANS}`;
  ctx.textBaseline = "middle";
  if (railX) {
    ctx.strokeStyle = COLORS.muted;
    ctx.globalAlpha = A * 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(railX, Math.max(0, toScreen(L.nodes.length ? L.nodes[0].y : 0)));
    ctx.lineTo(railX, Math.min(h, toScreen(L.baseY)));
    ctx.stroke();
  }

  const y0 = Math.max(0, top);
  const y1 = Math.min(bottom, L.poolY);
  const strandA = A * Math.min(1, s.reveal * 2);
  for (const strand of [0, 1] as const) {
    strandPath(ctx, cx, strand, false, y0, y1, toScreen, L.baseY);
    strokeGlass(ctx, strand, false, strandA);
  }

  // rungs (links): quiet blue-white; the selection's rungs are bright and carry light
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = A * (s.selected ? 0.12 : 0.24) * s.reveal;
  const hot: [HelixNode, HelixNode][] = [];
  ctx.beginPath();
  for (const r of L.rungs) {
    const [a, b] = r;
    if (Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
    if (s.selected && (a.note.path === s.selected || b.note.path === s.selected)) hot.push(r);
    else rungPath(ctx, a, b, cx, toScreen);
  }
  ctx.stroke();

  for (const strand of [0, 1] as const) {
    strandPath(ctx, cx, strand, true, y0, y1, toScreen, L.baseY);
    strokeGlass(ctx, strand, true, strandA);
  }

  // light rising up the front of the strands: memory rising from the spring
  if (s.fx.sparks && L.nodes.length) {
    const spark = glowSprite(COLORS.node, 0.15);
    const dTop = L.baseY - y0;
    const dBot = Math.max(-80, L.baseY - y1);
    const span = Math.max(1, dTop - dBot);
    ctx.globalCompositeOperation = "lighter";
    for (const strand of [0, 1] as const) {
      for (let k = 0; k < s.fx.sparks; k++) {
        const d = dBot + wrap(t * (45 + hash(k, 31 + strand) * 50) + hash(k, 33 + strand) * span, span);
        const depth = strandDepth(d, strand);
        if (depth < 0.1) continue;
        ctx.globalAlpha = A * depth * 0.85;
        blit(ctx, spark, cx + strandX(d, strand), toScreen(L.baseY - d), 9 + depth * 7);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  if (hot.length) {
    ctx.beginPath();
    for (const [a, b] of hot) rungPath(ctx, a, b, cx, toScreen);
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = A * 0.25;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.globalAlpha = A * 0.95;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    if (s.fx.pulses) {
      const pulse = glowSprite(COLORS.node, 0.2);
      ctx.globalCompositeOperation = "lighter";
      for (const [a, b] of hot) {
        const [from, to] = a.note.path === s.selected ? [a, b] : [b, a];
        const x0 = cx + strandX(from.d, from.strand), yA = toScreen(from.y);
        const x1 = cx + strandX(to.d, to.strand), yB = toScreen(to.y);
        for (let j = 0; j < 3; j++) {
          const u = wrap(t * 0.5 + j / 3, 1);
          const p = quadAt(x0, yA, cx, (yA + yB) / 2, x1, yB, u);
          ctx.globalAlpha = A * Math.sin(u * Math.PI);
          blit(ctx, pulse, p.x, p.y, 14);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // nodes: back half first, then front, so depth reads correctly
  const span = Math.max(1, last - first + 1);
  const glows = [glowSprite(COLORS.strand[0], 0.12), glowSprite(COLORS.strand[1], 0.12)];
  let selPos: { x: number; y: number } | null = null;
  for (const pass of [0, 1]) {
    for (let i = first; i <= last; i++) {
      const n = L.nodes[i];
      const depth = strandDepth(n.d, n.strand);
      if ((depth >= 0 ? 1 : 0) !== pass) continue;
      const x = cx + strandX(n.d, n.strand);
      const y = toScreen(n.y);
      const p = n.note.path;
      const isSel = p === s.selected;
      const isHover = p === s.hover;
      const dim = s.selected && !s.neighbours.has(p);
      const lit = Math.max(0, Math.min(1, s.reveal * 1.6 - ((last - i) / span) * 0.6)); // light from the water up
      const a = A * lit * (dim ? 0.28 : 1);
      if (a <= 0.01) continue;
      if (s.fx.glow) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a * (0.3 + 0.25 * depth);
        blit(ctx, glows[n.strand], x, y, 26 + depth * 10 + (isHover ? 10 : 0));
        ctx.globalCompositeOperation = "source-over";
      }
      if (s.proposed.has(p)) proposedMarker(ctx, x, y, a, t, s.fx.animate); // gold: an agent is asking
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, 3.8 + depth * 1.4, 0, TAU);
      ctx.fillStyle = COLORS.node;
      ctx.fill();
      ring(ctx, x, y, 6 + depth * 1.4, COLORS.strand[n.strand], 1.1);
      if (isSel) selPos = { x, y };
      if (isHover && !isSel) ring(ctx, x, y, 11, COLORS.select, 1.4);

      ctx.font = isSel ? FONT_SEL : FONT;
      ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
      ctx.globalAlpha = a * (isSel || isHover ? 1 : 0.5 + (depth + 1) * 0.2);
      const right = x >= cx;
      ctx.textAlign = right ? "left" : "right";
      ctx.fillText(shortTitle(n.note.title), x + (right ? 17 : -17), y);
      if (railX && i % 4 === 0) {
        ctx.font = `11px ${SANS}`;
        ctx.textAlign = "right";
        ctx.fillStyle = COLORS.muted;
        ctx.globalAlpha = A * lit * 0.85;
        ctx.fillText(day(timeOf(n.note)), railX - 10, y);
        ctx.beginPath();
        ctx.arc(railX, y, 2, 0, TAU);
        ctx.fill();
      }
    }
  }
  if (selPos) selectionMark(ctx, selPos.x, selPos.y, A, t, s);
  if (s.flash) {
    const n = L.byPath.get(s.flash.path);
    if (n) settledFlash(ctx, cx + strandX(n.d, n.strand), toScreen(n.y), s.flash.age, A);
  }

  // the coil dissolves into darkness at the top and bottom edges
  edgeFade(ctx, view);
  ctx.globalAlpha = A;
  ctx.font = `11px ${SANS}`;
  if (L.nodes.length) {
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(s.scrollY < 20 ? "newest  ▲" : "newer  ▲", w - 16, 18);
    ctx.fillText("the spring  ▼", w - 16, h - 16);
  }
  ctx.globalAlpha = 1;
}

/** The focused note: halo, ring, two orbiting lights and a one-off burst of sparks. */
function selectionMark(ctx: CanvasRenderingContext2D, x: number, y: number, A: number, t: number, s: { fx: TierSpec; selectedAt: number }) {
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = A * 0.8;
  blit(ctx, glowSprite(COLORS.node, 0.18), x, y, 46);
  if (s.fx.animate) {
    const orb = glowSprite(COLORS.node, 0.3);
    for (let j = 0; j < 2; j++) {
      const a = t * 1.6 + j * Math.PI;
      ctx.globalAlpha = A * 0.9;
      blit(ctx, orb, x + Math.cos(a) * 13, y + Math.sin(a) * 13 * 0.55, 7);
    }
    const age = t - s.selectedAt;
    if (age >= 0 && age < 0.9) {
      const spark = glowSprite(COLORS.node, 0.25);
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * TAU + hash(k, 41);
        const r = (1 - Math.pow(1 - age / 0.9, 3)) * (24 + hash(k, 42) * 26);
        ctx.globalAlpha = A * (1 - age / 0.9);
        blit(ctx, spark, x + Math.cos(ang) * r, y + Math.sin(ang) * r, 6);
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ring(ctx, x, y, 10, COLORS.select, 1.8);
}

/**
 * Pending agent proposal: a gold halo and ring that pulse (helix spec section 4: "an agent is
 * asking"). The only gold in the working view. Static when effects are off.
 */
function proposedMarker(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, t = 0, animate = false) {
  const beat = animate ? 0.5 + 0.5 * Math.sin(t * 2.6) : 0.5;
  ctx.globalAlpha = a * (0.4 + 0.35 * beat);
  blit(ctx, glowSprite(COLORS.gold, 0.2), x, y, 30 + 16 * beat);
  ctx.globalAlpha = a;
  ring(ctx, x, y, 10, COLORS.gold, 2);
  if (animate) {
    ctx.globalAlpha = a * (1 - beat) * 0.8;
    ring(ctx, x, y, 10 + 8 * beat, COLORS.gold, 1);
  }
}

/** A proposal on this note just settled: one expanding white ring, then gone. */
function settledFlash(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, A: number) {
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = A * (1 - age) * 0.9;
  blit(ctx, glowSprite(COLORS.node, 0.25), x, y, 30 + 60 * age);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = A * (1 - age);
  ring(ctx, x, y, 10 + 34 * age, COLORS.select, 2);
}

function edgeFade(ctx: CanvasRenderingContext2D, view: View) {
  const f = 70;
  for (const [y0, y1] of [[0, f], [view.h, view.h - f]]) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, withAlpha(COLORS.bg, 0.85));
    g.addColorStop(1, withAlpha(COLORS.bg, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.min(y0, y1), view.w, f);
  }
}

function rungPath(ctx: CanvasRenderingContext2D, a: HelixNode, b: HelixNode, cx: number, toScreen: (y: number) => number) {
  ctx.moveTo(cx + strandX(a.d, a.strand), toScreen(a.y));
  // control point on the helix axis: neighbouring rows read as straight rungs, distant links bow through the core
  ctx.quadraticCurveTo(cx, (toScreen(a.y) + toScreen(b.y)) / 2, cx + strandX(b.d, b.strand), toScreen(b.y));
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

// ---- graph mode ---------------------------------------------------------------

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
  t: number;
  fx: TierSpec;
  selectedAt: number;
  alpha: number;
  /** Link count per note: hubs draw larger and keep their labels when zoomed out. */
  degree: Map<string, number>;
  /** Degree at or above which a note counts as a hub. */
  hubDegree: number;
  flash?: { path: string; age: number; ok: boolean } | null;
}

export const graphToScreen = (view: View, gv: GraphView, p: { x: number; y: number }) => ({
  x: centreX(view) + (p.x - gv.x) * gv.zoom,
  y: view.h / 2 + (p.y - gv.y) * gv.zoom,
});

export function drawGraph(ctx: CanvasRenderingContext2D, view: View, s: GraphDrawState) {
  const A = s.alpha;
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.rung;
  ctx.globalAlpha = A * (s.selected ? 0.1 : 0.22);
  ctx.beginPath();
  const hot: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (const l of s.links) {
    const a = s.pts.get(l.src);
    const b = s.pts.get(l.dst);
    if (!a || !b) continue;
    const pa = graphToScreen(view, s.gv, a);
    const pb = graphToScreen(view, s.gv, b);
    if (s.selected && (l.src === s.selected || l.dst === s.selected)) {
      hot.push(l.src === s.selected ? [pa, pb] : [pb, pa]);
      continue;
    }
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
  if (hot.length) {
    ctx.beginPath();
    for (const [a, b] of hot) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.strokeStyle = COLORS.select;
    ctx.globalAlpha = A * 0.85;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (s.fx.pulses) {
      const pulse = glowSprite(COLORS.node, 0.2);
      ctx.globalCompositeOperation = "lighter";
      for (const [a, b] of hot) {
        for (let j = 0; j < 2; j++) {
          const u = wrap(s.t * 0.6 + j / 2, 1);
          ctx.globalAlpha = A * Math.sin(u * Math.PI);
          blit(ctx, pulse, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, 12);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }
  const glow = glowSprite(COLORS.strand[0], 0.12);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let selPos: { x: number; y: number } | null = null;
  const labels: [string, number, number, boolean, number][] = [];
  // Additive glow must scale with crowding, or thousands of halos sum to a white-out.
  let visible = 0;
  for (const p of s.pts.values()) {
    const q = graphToScreen(view, s.gv, p);
    if (q.x > -30 && q.y > -30 && q.x < view.w + 30 && q.y < view.h + 30) visible++;
  }
  const density = Math.min(1, 220 / Math.max(1, visible));
  const shrink = Math.max(0.45, Math.min(1, s.gv.zoom));
  for (const [path, p] of s.pts) {
    const { x, y } = graphToScreen(view, s.gv, p);
    if (x < -30 || y < -30 || x > view.w + 30 || y > view.h + 30) continue;
    const deg = s.degree.get(path) || 0;
    const r = (3 + Math.min(6, Math.sqrt(deg) * 1.4)) * shrink;
    const isSel = path === s.selected;
    const isHover = path === s.hover;
    const near = s.neighbours.has(path);
    const dim = s.selected && !isSel && !near;
    const a = A * (dim ? (density < 1 ? 0.1 : 0.22) : 1);
    if (s.fx.glow && !dim) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = a * (0.3 + Math.min(0.4, deg * 0.04)) * (isSel || near ? 1 : density);
      blit(ctx, glow, x, y, r * 6 + (isHover ? 10 : 0));
      ctx.globalCompositeOperation = "source-over";
    }
    if (s.proposed.has(path)) proposedMarker(ctx, x, y, a, s.t, s.fx.animate);
    ctx.globalAlpha = a * (dim || isSel || near ? 1 : 0.35 + 0.65 * density);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = COLORS.node;
    ctx.fill();
    if (isSel) selPos = { x, y };
    if (isHover && !isSel) ring(ctx, x, y, r + 6, COLORS.select, 1.4);
    const hub = deg >= s.hubDegree;
    if (isSel || isHover || near || s.gv.zoom >= 1.6 || (hub && !s.selected && density > 0.5)) labels.push([path, x + r + 7, y, isSel, a]);
  }
  // the focused neighbourhood is redrawn on top of the crowd so it is never buried
  if (s.selected) {
    for (const path of s.neighbours) {
      const p = s.pts.get(path);
      if (!p) continue;
      const { x, y } = graphToScreen(view, s.gv, p);
      const r = (3 + Math.min(6, Math.sqrt(s.degree.get(path) || 0) * 1.4)) * shrink;
      ctx.globalAlpha = A;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = COLORS.node;
      ctx.fill();
    }
  }
  // labels last, so no node or glow is drawn over a title
  for (const [path, x, y, isSel, a] of labels) {
    ctx.font = isSel ? FONT_SEL : FONT;
    ctx.fillStyle = isSel ? COLORS.select : COLORS.text;
    ctx.globalAlpha = a * (isSel ? 1 : 0.85);
    ctx.fillText(shortTitle(s.titles.get(path) || path), x, y);
  }
  if (selPos) selectionMark(ctx, selPos.x, selPos.y, A, s.t, s);
  if (s.flash) {
    const p = s.pts.get(s.flash.path);
    if (p) {
      const q = graphToScreen(view, s.gv, p);
      settledFlash(ctx, q.x, q.y, s.flash.age, A);
    }
  }
  ctx.globalAlpha = 1;
}

export { ROW_GAP };
