import { describe, expect, it } from "vitest";
import { QualityGovernor, TIERS, hash, quadAt, wrap } from "../src/fx";

describe("quality governor", () => {
  const run = (g: QualityGovernor, drawMs: number, dtMs: number, frames: number) => {
    let changed = false;
    for (let i = 0; i < frames; i++) changed = g.sample(drawMs, dtMs) || changed;
    return changed;
  };
  it("judges by frame interval, since canvas raster cost lands after the draw call", () => {
    const g = new QualityGovernor(3, 0);
    expect(run(g, 1, 33, 40)).toBe(true); // cheap draw calls, but frames are slow
    expect(g.tier).toBe(2);
  });
  it("ignores a single slow frame", () => {
    const g = new QualityGovernor(3, 0);
    g.sample(1, 120);
    run(g, 1, 16.7, 60);
    expect(g.tier).toBe(3);
  });
  it("also steps down when our own draw work is heavy", () => {
    const g = new QualityGovernor(3, 0);
    run(g, 14, 16.7, 120);
    expect(g.tier).toBeLessThan(3);
  });
  it("can fall all the way to static (tier 0), the below-floor fallback, and stays there", () => {
    const g = new QualityGovernor(3, 0);
    run(g, 1, 50, 2000);
    expect(g.tier).toBe(0);
    run(g, 0.1, 16.7, 2000); // a static view produces no evidence to climb back on
    expect(g.tier).toBe(0);
  });
  it("respects a floor", () => {
    const g = new QualityGovernor(3, 1);
    run(g, 1, 50, 2000);
    expect(g.tier).toBe(1);
  });
  it("upgrades on sustained headroom, but gives up on a tier that failed twice", () => {
    const g = new QualityGovernor(3, 0);
    run(g, 1, 30, 50); // fail 3
    expect(g.tier).toBe(2);
    run(g, 1, 16.7, 400); // recover
    expect(g.tier).toBe(3);
    run(g, 1, 30, 50); // fail 3 again
    expect(g.tier).toBe(2);
    run(g, 1, 16.7, 2000);
    expect(g.tier).toBe(2);
  });
});

describe("analytic particles", () => {
  it("hash is deterministic and in 0..1", () => {
    for (let i = 0; i < 500; i++) {
      const h = hash(i, 7);
      expect(h).toBe(hash(i, 7));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(hash(1, 1)).not.toBe(hash(1, 2));
  });
  it("wrap is a positive modulo", () => {
    expect(wrap(-1, 10)).toBe(9);
    expect(wrap(23, 10)).toBe(3);
  });
  it("quadAt hits both endpoints", () => {
    expect(quadAt(0, 0, 5, 5, 10, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(quadAt(0, 0, 5, 5, 10, 0, 1)).toEqual({ x: 10, y: 0 });
  });
  it("tier 0 is fully static and tiers only add effects", () => {
    expect(TIERS[0].animate).toBe(false);
    expect(TIERS[3].dust).toBeGreaterThan(TIERS[2].dust);
    expect(TIERS[2].dust).toBeGreaterThanOrEqual(TIERS[1].dust);
  });
});
