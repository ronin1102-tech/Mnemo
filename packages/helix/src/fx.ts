/**
 * Effects core. Every particle here is *analytic*: its position is a pure function of
 * (index, time), so nothing is allocated or simulated per frame and the cost is just the
 * draw calls. Glow comes from pre-rendered sprites (drawImage), never shadowBlur or
 * ctx.filter, which are slow on software-rendered canvases and absent in Safari 13.
 */

/** Effect tiers. 0 = static (no animation loop at all). */
export type Tier = 0 | 1 | 2 | 3;
export const TIER_NAMES = ["Off", "Low", "Medium", "High"] as const;

export interface TierSpec {
  dust: number; // ambient motes across the stage
  motes: number; // bubbles rising from the spring
  sparks: number; // light travelling up each strand, per strand
  pulses: boolean; // light travelling along focused links
  glow: boolean; // node halos
  animate: boolean; // continuous loop (ripples, light, dust)
}

export const TIERS: Record<Tier, TierSpec> = {
  0: { dust: 0, motes: 0, sparks: 0, pulses: false, glow: true, animate: false },
  1: { dust: 0, motes: 10, sparks: 0, pulses: false, glow: true, animate: true },
  2: { dust: 70, motes: 26, sparks: 6, pulses: true, glow: true, animate: true },
  3: { dust: 150, motes: 48, sparks: 11, pulses: true, glow: true, animate: true },
};

/** Deterministic 0..1 hash of an integer and a salt. */
export function hash(i: number, salt = 0): number {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Positive modulo. */
export const wrap = (v: number, m: number) => ((v % m) + m) % m;

/** Point on a quadratic Bézier at u in 0..1. */
export function quadAt(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, u: number) {
  const a = (1 - u) * (1 - u);
  const b = 2 * (1 - u) * u;
  const c = u * u;
  return { x: a * x0 + b * cx + c * x1, y: a * y0 + b * cy + c * y1 };
}

// ---- sprites -------------------------------------------------------------

const spriteCache = new Map<string, HTMLCanvasElement>();

/**
 * A soft radial glow, cached by colour. Drawn with drawImage at any size.
 * `core` (0..1) is how much of the radius is a bright centre.
 */
export function glowSprite(color: string, core = 0.18): HTMLCanvasElement {
  const key = color + "|" + core;
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(core, color);
  grad.addColorStop(Math.min(0.95, core + 0.3), withAlpha(color, 0.35));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  spriteCache.set(key, c);
  return c;
}

/** "#rrggbb" + alpha -> "rgba(...)". */
export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Draw a sprite centred at (x, y) with diameter `size`. */
export function blit(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, x: number, y: number, size: number) {
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
}

// ---- adaptive quality ------------------------------------------------------

/**
 * Keeps the frame budget on old hardware. The primary signal is the *frame interval*: canvas
 * drawing is deferred (the browser rasterizes after our draw call returns), so timing the draw
 * call alone misses most of the cost. Draw time is a secondary signal. Steps down a tier after
 * a sustained second over budget, and up again after five seconds of headroom, but never
 * retries a tier that has failed twice (no oscillation). The floor can be 0: static rendering,
 * the helix spec's below-floor fallback.
 */
export class QualityGovernor {
  tier: Tier;
  private dtEma = 0;
  private drawEma = 0;
  private overMs = 0;
  private underMs = 0;
  private failures: Record<number, number> = {};

  constructor(
    private max: Tier = 3,
    private min: Tier = 0,
    private slowFrame = 21, // ms between frames above which we are missing 60 fps (with slack)
    private heavyDraw = 9, // ms of our own draw work that is too much regardless
  ) {
    this.tier = max;
  }

  /** Feed one drawn frame. Returns true if the tier changed. */
  sample(drawMs: number, dtMs: number): boolean {
    this.dtEma = this.dtEma ? this.dtEma * 0.9 + dtMs * 0.1 : dtMs;
    this.drawEma = this.drawEma ? this.drawEma * 0.9 + drawMs * 0.1 : drawMs;
    const over = this.dtEma > this.slowFrame || this.drawEma > this.heavyDraw;
    const headroom = this.dtEma < 18 && this.drawEma < this.heavyDraw / 2;
    if (over) {
      this.overMs += dtMs;
      this.underMs = 0;
    } else if (headroom) {
      this.underMs += dtMs;
      this.overMs = 0;
    } else {
      this.overMs = this.underMs = 0;
    }
    // stepping down to static needs longer proof than shedding a few particles
    const patience = this.tier === 1 ? 1500 : 1000;
    if (this.overMs > patience && this.tier > this.min) {
      this.failures[this.tier] = (this.failures[this.tier] || 0) + 1;
      this.tier = (this.tier - 1) as Tier;
      this.reset();
      return true;
    }
    const next = (this.tier + 1) as Tier;
    if (this.underMs > 5000 && this.tier < this.max && this.tier > 0 && (this.failures[next] || 0) < 2) {
      this.tier = next;
      this.reset();
      return true;
    }
    return false;
  }

  private reset() {
    this.overMs = this.underMs = 0;
    this.dtEma = this.drawEma = 0;
  }
}
