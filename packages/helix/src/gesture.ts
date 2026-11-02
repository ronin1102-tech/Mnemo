/** Pure math for the graph's pinch-to-zoom. Kept free of DOM so it can be unit-tested. */

export interface Pt {
  x: number;
  y: number;
}
export interface View2 {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const distance = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * One step of a two-finger gesture. The graph is drawn at screen = centre + (world - gv) * zoom, so
 * the world point under the fingers' old midpoint is kept under their new midpoint: spreading zooms
 * in around the fingers, and moving both fingers together pans. `cx`/`cy` is the screen position of
 * the view's centre (where gv sits). Returns the same view if the fingers haven't really moved.
 */
export function pinchStep(gv: View2, from: { mid: Pt; dist: number }, to: { mid: Pt; dist: number }, cx: number, cy: number): View2 {
  if (!(from.dist > 1) || !(to.dist > 1)) return gv; // fingers on top of each other: no usable scale
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gv.zoom * (to.dist / from.dist)));
  const wx = gv.x + (from.mid.x - cx) / gv.zoom;
  const wy = gv.y + (from.mid.y - cy) / gv.zoom;
  return { x: wx - (to.mid.x - cx) / zoom, y: wy - (to.mid.y - cy) / zoom, zoom };
}
