import { COLORS } from "./colors";
import { blit, glowSprite, hash, wrap } from "./fx";
import type { TierSpec } from "./fx";
import { drawWater } from "./render";
import type { View } from "./render";

/**
 * Emblem mode: the Mnemo mark, alive. This is the ONLY file allowed to use the mark's own
 * gold (COLORS.markGold), a branding surface; the working graph reserves gold for agent
 * proposals (enforced by test/colors.test.ts).
 */

const TAU = Math.PI * 2;
let ringCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** The ornamental ring (rules, Greek-key clusters, laurel sprigs). Static, so drawn once per size. */
function ringLayer(R: number, dpr: number, minimal = false): HTMLCanvasElement {
  const key = `${Math.round(R)}|${dpr}|${minimal}`;
  if (ringCache && ringCache.key === key) return ringCache.canvas;
  const size = Math.ceil(R * 2 + 16);
  const c = document.createElement("canvas");
  c.width = c.height = Math.ceil(size * dpr);
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.scale(dpr, dpr);
  const cx = size / 2;
  const cy = size / 2;
  g.strokeStyle = g.fillStyle = COLORS.markGold;
  g.lineCap = "square";
  // strokes are tuned for R = 300 and scale with the emblem, so the mark holds together from icon to full screen
  const k = Math.max(0.3, R / 300);
  const circle = (r: number, lw: number, a: number, dash?: number[]) => {
    g.globalAlpha = a;
    g.lineWidth = lw;
    g.setLineDash(dash || []);
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.stroke();
  };
  if (minimal) {
    // icon sizes: one confident ring; the key pattern and laurels can't survive at 16-48 px
    circle(R * 0.97, Math.max(1, R * 0.06), 1);
    ringCache = { key, canvas: c };
    return c;
  }
  circle(R, 2.2 * k, 0.95);
  circle(R * 0.982, 0.8 * k, 0.6);
  circle(R * 0.9, 1.2 * k, 0.85);
  circle(R * 0.884, 0.6 * k, 0.45);
  g.setLineDash([]);

  // band between the rules carries eight Greek-key clusters and eight laurel sprigs
  const rIn = R * 0.915;
  const hb = R * 0.052;
  const unit = hb * 1.05;
  const polar = (a0: number, u: number, v: number) => {
    const a = a0 + u / (rIn + hb / 2);
    const r = rIn + v * hb;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const KEY: [number, number][] = [[0, 0], [0, 0.92], [0.78, 0.92], [0.78, 0.22], [0.32, 0.22], [0.32, 0.6], [0.56, 0.6]];
  g.lineWidth = 1.1 * k;
  g.globalAlpha = 0.9;
  for (let q = 0; q < 8; q++) {
    const a0 = (q / 8) * TAU - Math.PI / 2 + TAU / 16;
    const units = 5;
    const start = -units / 2;
    g.beginPath();
    for (let u = 0; u < units; u++) {
      KEY.forEach(([x, y], i) => {
        const [px, py] = polar(a0, (start + u + x) * unit, y);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      const [bx, by] = polar(a0, (start + u + 1) * unit, 0);
      const [ax, ay] = polar(a0, (start + u) * unit, 0);
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
    }
    g.stroke();
  }
  // dotted rule through the open stretches of the band
  circle(rIn + hb / 2, 1 * k, 0.55, [1 * k, 4 * k]);
  g.setLineDash([]);

  // laurel sprigs, centred between key clusters
  for (let q = 0; q < 8; q++) {
    const a = (q / 8) * TAU - Math.PI / 2;
    const r = rIn + hb / 2;
    const span = (hb * 2.6) / r;
    g.globalAlpha = 0.85;
    g.lineWidth = 0.8 * k;
    g.beginPath();
    g.arc(cx, cy, r, a - span / 2, a + span / 2);
    g.stroke();
    for (let j = 0; j < 5; j++) {
      const t = a - span / 2 + (span * (j + 0.5)) / 5;
      const side = j % 2 ? 1 : -1;
      const lr = r + side * hb * 0.24;
      g.save();
      g.translate(cx + lr * Math.cos(t), cy + lr * Math.sin(t));
      g.rotate(t + Math.PI / 2 + side * 0.55);
      g.beginPath();
      g.ellipse(0, 0, hb * 0.34, hb * 0.13, 0, 0, TAU);
      g.fill();
      g.restore();
    }
  }
  ringCache = { key, canvas: c };
  return c;
}

/**
 * The mark: gold ring, water-blue coil turning slowly as it rises out of the spring, gold
 * beads that glint, motes drifting up from the water. `t` is seconds (frozen at 0 when static).
 */
export function drawEmblem(ctx: CanvasRenderingContext2D, view: View, t: number, scale: number, alpha: number, fx: TierSpec, dpr: number, opts: { minimal?: boolean } = {}) {
  if (alpha <= 0) return;
  const cx = view.w / 2;
  const cy = view.h / 2;
  const R = Math.min(view.w, view.h) * 0.44 * scale;
  const minimal = !!opts.minimal;
  // stroke and bead sizes are tuned for R = 300 and scale with the emblem (icon to full screen)
  const k = Math.max(0.3, R / 300);

  // aura behind the coil
  ctx.globalAlpha = alpha * 0.35;
  blit(ctx, glowSprite(COLORS.water, 0.02), cx, cy, R * 1.6);

  const ring = ringLayer(Math.min(view.w, view.h) * 0.44, dpr, minimal);
  const rs = ring.width / dpr;
  ctx.globalAlpha = alpha;
  ctx.drawImage(ring, cx - (rs * scale) / 2, cy - (rs * scale) / 2, rs * scale, rs * scale);

  const poolCy = cy + R * 0.56;
  drawWater(ctx, cx, poolCy, R * 0.66, alpha, t, fx.animate);

  const h = R * 1.2;
  const turns = 2.4;
  const rad = R * 0.15;
  const spin = t * 0.45; // the coil turns slowly; the working helix never does
  const at = (u: number, strand: number) => {
    const ph = u * turns * TAU + strand * Math.PI + spin;
    const taper = Math.min(1, u * 5 + 0.06); // narrows into the water
    return { x: cx + rad * taper * Math.sin(ph), y: poolCy - u * h, depth: Math.cos(ph) };
  };

  // back halves, rungs, front halves
  const strand = (s: number, front: boolean) => {
    ctx.beginPath();
    let pen = false;
    for (let u = 0; u <= 1.0001; u += 0.006) {
      const p = at(u, s);
      if (p.depth >= 0 !== front) { pen = false; continue; }
      if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      pen = true;
    }
    ctx.strokeStyle = COLORS.strand[s];
    ctx.lineCap = "round";
    ctx.globalAlpha = alpha * (front ? 0.2 : 0.09);
    ctx.lineWidth = (front ? 11 : 6) * k;
    ctx.stroke();
    ctx.globalAlpha = alpha * (front ? 0.95 : 0.38);
    ctx.lineWidth = (front ? 2.6 : 1.4) * k * (minimal ? 1.8 : 1);
    ctx.stroke();
    if (front) {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = COLORS.node;
      ctx.globalAlpha = alpha * 0.35;
      ctx.lineWidth = 0.8 * k;
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
  };
  strand(0, false);
  strand(1, false);
  if (minimal) {
    // icon sizes: ring, coil and water only (no rungs, beads or motes)
    strand(0, true);
    strand(1, true);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.strokeStyle = COLORS.rung;
  ctx.lineWidth = 1.1 * k;
  ctx.beginPath();
  for (let i = 1; i < 26; i++) {
    const a = at(i / 26, 0);
    const b = at(i / 26, 1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.globalAlpha = alpha * 0.32;
  ctx.stroke();
  strand(0, true);
  strand(1, true);

  // gold beads on one strand: the notes; each glints on its own beat
  const bead = glowSprite(COLORS.markGold, 0.3);
  ctx.globalCompositeOperation = "lighter";
  for (let i = 2; i < 25; i++) {
    const p = at(i / 26, 0);
    const glint = fx.animate ? 0.75 + 0.25 * Math.sin(t * 2.1 + i * 1.7) : 1;
    const size = (p.depth >= 0 ? 15 : 10) * k * glint;
    ctx.globalAlpha = alpha * (p.depth >= 0 ? 0.95 : 0.45);
    blit(ctx, bead, p.x, p.y, size);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = COLORS.markGold;
  for (let i = 2; i < 25; i++) {
    const p = at(i / 26, 0);
    ctx.globalAlpha = alpha * (p.depth >= 0 ? 1 : 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (p.depth >= 0 ? 3.6 : 2.6) * k, 0, TAU);
    ctx.fill();
  }

  // motes rising from the spring through the coil
  if (fx.motes) {
    const mote = glowSprite(COLORS.node, 0.12);
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < fx.motes; k++) {
      const life = wrap(t * (0.05 + hash(k, 1) * 0.07) + hash(k, 2), 1);
      const y = poolCy - life * h * 1.1;
      const x = cx + (hash(k, 3) - 0.5) * rad * 4 * (0.4 + life) + Math.sin(t * 0.8 + k) * 5;
      ctx.globalAlpha = alpha * Math.sin(life * Math.PI) * (0.35 + 0.45 * hash(k, 4));
      blit(ctx, mote, x, y, (4 + hash(k, 5) * 7) * Math.min(1, R / 300));
    }
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.globalAlpha = 1;
}
