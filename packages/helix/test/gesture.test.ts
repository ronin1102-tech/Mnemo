import { distance, midpoint, MAX_ZOOM, MIN_ZOOM, pinchStep } from "../src/gesture";
import { describe, expect, it } from "./expect";

const CX = 200, CY = 300;
const toScreen = (gv: { x: number; y: number; zoom: number }, p: { x: number; y: number }) => ({ x: CX + (p.x - gv.x) * gv.zoom, y: CY + (p.y - gv.y) * gv.zoom });
const state = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ mid: midpoint(a, b), dist: distance(a, b) });

describe("graph pinch gesture", () => {
  it("spreading two fingers zooms in, and the point between them stays put", () => {
    const gv = { x: 50, y: -20, zoom: 1 };
    const a = { x: 150, y: 250 }, b = { x: 250, y: 350 };
    const world = { x: gv.x + (200 - CX) / 1, y: gv.y + (300 - CY) / 1 }; // under the midpoint
    const next = pinchStep(gv, state(a, b), state({ x: 100, y: 200 }, { x: 300, y: 400 }), CX, CY);
    expect(next.zoom).toBeCloseTo(2, 6);
    const s = toScreen(next, world);
    expect(s.x).toBeCloseTo(200, 6);
    expect(s.y).toBeCloseTo(300, 6);
  });
  it("pinching in zooms out, and any off-centre point under the fingers also stays put", () => {
    const gv = { x: 0, y: 0, zoom: 2 };
    const a = { x: 40, y: 80 }, b = { x: 120, y: 160 };
    const mid = midpoint(a, b);
    const world = { x: gv.x + (mid.x - CX) / gv.zoom, y: gv.y + (mid.y - CY) / gv.zoom };
    const next = pinchStep(gv, state(a, b), state({ x: 60, y: 100 }, { x: 100, y: 140 }), CX, CY);
    expect(next.zoom).toBeCloseTo(1, 6);
    const s = toScreen(next, world);
    expect(s.x).toBeCloseTo(80, 6);
    expect(s.y).toBeCloseTo(120, 6);
  });
  it("moving both fingers together (no change in spread) pans", () => {
    const gv = { x: 10, y: 10, zoom: 2 };
    const a = { x: 100, y: 100 }, b = { x: 200, y: 100 };
    const next = pinchStep(gv, state(a, b), state({ x: 140, y: 120 }, { x: 240, y: 120 }), CX, CY);
    expect(next.zoom).toBe(2);
    expect(next.x).toBeCloseTo(10 - 40 / 2, 6); // dragged right: the view moves left
    expect(next.y).toBeCloseTo(10 - 20 / 2, 6);
  });
  it("zoom is clamped to the same limits as the mouse wheel", () => {
    const a = { x: 100, y: 100 }, b = { x: 110, y: 100 };
    expect(pinchStep({ x: 0, y: 0, zoom: 3.9 }, state(a, b), state({ x: 0, y: 100 }, { x: 300, y: 100 }), CX, CY).zoom).toBe(MAX_ZOOM);
    expect(pinchStep({ x: 0, y: 0, zoom: 0.25 }, state({ x: 0, y: 0 }, { x: 300, y: 0 }), state(a, b), CX, CY).zoom).toBe(MIN_ZOOM);
  });
  it("fingers on top of each other give no scale, so the view is left alone", () => {
    const gv = { x: 1, y: 2, zoom: 1.5 };
    const p = { x: 50, y: 50 };
    expect(pinchStep(gv, state(p, p), state({ x: 0, y: 0 }, { x: 100, y: 0 }), CX, CY)).toEqual(gv);
    expect(pinchStep(gv, state({ x: 0, y: 0 }, { x: 100, y: 0 }), state(p, p), CX, CY)).toEqual(gv);
  });
});
