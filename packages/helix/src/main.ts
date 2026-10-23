import { COLORS } from "./colors";
import { demoData } from "./demo";
import { layoutGraph, layoutHelix, ROW_GAP, timeOf, withinHops } from "./layout";
import type { GraphPoint, HelixLayout } from "./layout";
import { drawEmblem, drawGraph, drawHelix, graphToScreen, helixPos, poolHit } from "./render";
import type { GraphView } from "./render";
import type { GraphData } from "./types";

type Mode = "emblem" | "helix" | "graph";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("stage");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const listEl = $<HTMLUListElement>("strand-list");
const detailEl = $<HTMLElement>("detail");
const liveEl = $<HTMLElement>("live");
const sourceEl = $<HTMLElement>("source");

const injected = (window as unknown as { __MNEMO_GRAPH__?: GraphData }).__MNEMO_GRAPH__;
const data: GraphData = injected || demoData();
sourceEl.textContent = injected ? `Vault snapshot ${injected.generatedAt.slice(0, 16).replace("T", " ")} · ${data.nodes.length} notes` : "Demo data — run `mnemo-ctl export-graph` to load your vault";

const layout: HelixLayout = layoutHelix(data);
// Graph-mode layout is computed on first use, so opening the helix never pays for it.
let graphPtsCache: Map<string, GraphPoint> | null = null;
const graphPoints = () => graphPtsCache || (graphPtsCache = layoutGraph(data.nodes, data.links));
const titles = new Map(data.nodes.map((n) => [n.path, n.title]));
const proposed = new Set(data.proposals.map((p) => p.path));
const adj = new Map<string, Set<string>>();
for (const l of data.links) {
  if (!titles.has(l.src) || !titles.has(l.dst)) continue;
  if (!adj.has(l.src)) adj.set(l.src, new Set());
  if (!adj.has(l.dst)) adj.set(l.dst, new Set());
  adj.get(l.src)!.add(l.dst);
  adj.get(l.dst)!.add(l.src);
}
const EMPTY = new Set<string>();

const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

let mode: Mode = "emblem";
let emb = 0; // 0 = emblem, 1 = full view; animated
let embTarget = 0;
let embMs = 250; // duration of the current emblem <-> view transition
let rising = false; // the 1.2s rising transition (plays once per vault open)
let risePlayed = false;
let depth = 1; // focus hop depth, 1-3
let scrollY = 0;
let selected: string | null = null;
let hover: string | null = null;
let gv: GraphView = { x: 0, y: 0, zoom: 1 };
const view = { w: 0, h: 0 };
let dirty = true;
let raf = 0;
let lastT = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: cheap on software-rendered canvases
  const r = canvas.getBoundingClientRect();
  view.w = Math.max(1, Math.floor(r.width));
  view.h = Math.max(1, Math.floor(r.height));
  canvas.width = Math.floor(view.w * dpr);
  canvas.height = Math.floor(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampScroll();
  request();
}

const maxScroll = () => Math.max(0, layout.height - view.h);
function clampScroll() {
  scrollY = Math.max(0, Math.min(maxScroll(), scrollY));
}

function request() {
  dirty = true;
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(t: number) {
  raf = 0;
  const dt = lastT ? Math.min(64, t - lastT) : 16;
  lastT = t;
  let animating = false;
  if (emb !== embTarget) {
    emb += Math.sign(embTarget - emb) * Math.min(Math.abs(embTarget - emb), dt / embMs);
    animating = emb !== embTarget;
    if (!animating) rising = false;
  }
  draw();
  dirty = false;
  if (animating) raf = requestAnimationFrame(frame);
  else lastT = 0;
}

function neighbours(): Set<string> {
  return selected ? withinHops(adj, selected, depth) : EMPTY;
}

/** Ease-out for the rise. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function draw() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, view.w, view.h);
  if (emb < 1) drawEmblem(ctx, view, 1 + emb * 0.12, 1 - Math.min(1, emb * 1.6));
  if (emb > 0) {
    if (mode === "graph") {
      ctx.globalAlpha = emb;
      drawGraph(ctx, view, { pts: graphPoints(), links: data.links, titles, selected, hover, proposed, neighbours: neighbours(), gv });
      ctx.globalAlpha = 1;
    } else {
      const reveal = rising ? easeOut(emb) : 1;
      drawHelix(ctx, view, { layout, scrollY, selected, hover, proposed, neighbours: neighbours(), reveal, alpha: rising ? 1 : emb });
    }
  }
}

// ---- mode, selection ----------------------------------------------------

function setMode(m: Mode) {
  mode = m;
  embTarget = m === "emblem" ? 0 : 1;
  // The rise plays once, when the vault is first opened; later switches are a quick crossfade.
  // prefers-reduced-motion: crossfade only.
  rising = m === "helix" && !risePlayed && !reduceMotion && emb < 1;
  if (m !== "emblem") risePlayed = true;
  embMs = rising ? 1200 : 250;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  canvas.setAttribute("aria-label", canvasLabel());
  if (m === "emblem") hideDetail();
  request();
}

function canvasLabel() {
  const what = mode === "graph" ? "Graph" : "Helix";
  return mode === "emblem"
    ? "Mnemo emblem. Press Enter to open the helix."
    : `${what} of ${data.nodes.length} notes. Use arrow keys to move between notes; the note list beside it has the same content.`;
}

function select(path: string | null, reveal = true) {
  selected = path;
  for (const li of listEl.querySelectorAll<HTMLElement>("button[data-path]")) {
    if (li.dataset.path === path) li.setAttribute("aria-current", "true");
    else li.removeAttribute("aria-current");
  }
  if (path && reveal) {
    if (mode === "graph") {
      const p = graphPoints().get(path);
      if (p) gv = { ...gv, x: p.x, y: p.y };
    } else {
      const n = layout.byPath.get(path);
      if (n) {
        scrollY = n.y - view.h / 2;
        clampScroll();
      }
    }
  }
  if (path) showDetail(path);
  else hideDetail();
  request();
}

function showDetail(path: string) {
  const note = data.nodes.find((n) => n.path === path);
  if (!note) return;
  const out = data.links.filter((l) => l.src === path && titles.has(l.dst)).map((l) => l.dst);
  const inn = data.links.filter((l) => l.dst === path && titles.has(l.src)).map((l) => l.src);
  const props = data.proposals.filter((p) => p.path === path);
  detailEl.hidden = false;
  detailEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = note.title;
  detailEl.appendChild(h);
  detailEl.appendChild(el("p", "path", note.path + " · " + new Date(timeOf(note)).toISOString().slice(0, 10) + " · " + inn.length + " backlink" + (inn.length === 1 ? "" : "s")));
  if (note.excerpt) detailEl.appendChild(el("p", "excerpt", note.excerpt));
  if (note.tags.length) detailEl.appendChild(el("p", "tags", note.tags.map((t) => "#" + t).join(" ")));
  for (const p of props) detailEl.appendChild(el("p", "proposal", `Pending ${p.op} proposal from ${p.client}. Review with: mnemo-ctl show ${p.id}`));
  detailEl.appendChild(depthControl(path));
  detailEl.appendChild(linkGroup("Links to", out));
  detailEl.appendChild(linkGroup("Linked from", inn));
  liveEl.textContent = `Selected ${note.title}. ${out.length} outgoing, ${inn.length} incoming links.`;
}

/** Focus depth: how many link-hops stay lit around the selection. */
function depthControl(path: string) {
  const wrap = document.createElement("div");
  wrap.className = "depth";
  wrap.appendChild(el("span", "", "Depth"));
  for (const n of [1, 2, 3]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(n);
    b.setAttribute("aria-pressed", String(n === depth));
    b.setAttribute("aria-label", `Show ${n} link hop${n > 1 ? "s" : ""}`);
    b.addEventListener("click", () => {
      depth = n;
      showDetail(path);
      request();
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function hideDetail() {
  detailEl.hidden = true;
  detailEl.innerHTML = "";
}

function el(tag: string, cls: string, text: string) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function linkGroup(label: string, paths: string[]) {
  const wrap = document.createElement("div");
  wrap.appendChild(el("h3", "", `${label} (${paths.length})`));
  const ul = document.createElement("ul");
  for (const p of paths) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linkbtn";
    b.textContent = titles.get(p) || p;
    b.addEventListener("click", () => select(p));
    li.appendChild(b);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

// ---- accessible strand list ---------------------------------------------

function buildList() {
  const frag = document.createDocumentFragment();
  for (const n of layout.nodes) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.path = n.note.path;
    const deg = (adj.get(n.note.path) || EMPTY).size;
    const prop = proposed.has(n.note.path);
    b.setAttribute("aria-label", `${n.note.title}, ${new Date(timeOf(n.note)).toISOString().slice(0, 10)}, ${deg} links${prop ? ", has a pending agent proposal" : ""}`);
    const t = document.createElement("span");
    t.textContent = n.note.title;
    b.appendChild(t);
    if (prop) b.appendChild(el("span", "proposal badge", "proposal"));
    b.appendChild(el("span", "meta", String(deg)));
    b.addEventListener("click", () => {
      if (mode === "emblem") setMode("helix");
      select(n.note.path);
    });
    li.appendChild(b);
    frag.appendChild(li);
  }
  listEl.appendChild(frag);
}

// ---- pointer / keyboard ---------------------------------------------------

function pick(px: number, py: number): string | null {
  const R = 14;
  if (mode === "graph") {
    let best: string | null = null;
    let bd = R * R;
    for (const [path, p] of graphPoints()) {
      const s = graphToScreen(view, gv, p);
      const d = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py);
      if (d < bd) { bd = d; best = path; }
    }
    return best;
  }
  const lo = Math.max(0, Math.floor((scrollY + py - 60) / ROW_GAP) - 2);
  const hi = Math.min(layout.nodes.length - 1, lo + 5);
  let best: string | null = null;
  let bd = R * R;
  for (let i = lo; i <= hi; i++) {
    const n = layout.nodes[i];
    const s = helixPos(n, view, scrollY);
    const d = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py);
    if (d < bd) { bd = d; best = n.note.path; }
  }
  return best;
}

let drag: { x: number; y: number; moved: boolean } | null = null;

/** The rise is a layer, never a gate: any key or click skips it. */
function skipRise() {
  if (rising && emb !== embTarget) {
    emb = embTarget;
    rising = false;
    request();
  }
}
document.addEventListener("keydown", skipRise, true);

canvas.addEventListener("pointerdown", (e) => {
  skipRise();
  drag = { x: e.clientX, y: e.clientY, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
});
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (mode === "graph") gv = { ...gv, x: gv.x - dx / gv.zoom, y: gv.y - dy / gv.zoom };
    else if (mode === "helix") { scrollY -= dy; clampScroll(); }
    request();
  } else if (mode !== "emblem") {
    const h = pick(e.clientX - r.left, e.clientY - r.top);
    if (h !== hover) { hover = h; canvas.style.cursor = h ? "pointer" : "default"; request(); }
  }
});
canvas.addEventListener("pointerup", (e) => {
  const wasDrag = drag && drag.moved;
  drag = null;
  if (wasDrag) return;
  if (mode === "emblem") return setMode("helix");
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const hit = pick(px, py);
  if (!hit && mode === "helix" && poolHit(view, layout, scrollY, px, py)) {
    // the water is the root: back to the whole-vault view
    select(null);
    scrollY = 0;
    return request();
  }
  select(hit, false);
});
canvas.addEventListener("pointerleave", () => { if (hover) { hover = null; request(); } });
canvas.addEventListener("wheel", (e) => {
  if (mode === "emblem") return;
  e.preventDefault();
  if (mode === "graph") gv = { ...gv, zoom: Math.max(0.2, Math.min(4, gv.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) };
  else { scrollY += e.deltaY; clampScroll(); }
  request();
}, { passive: false });

canvas.addEventListener("keydown", (e) => {
  if (mode === "emblem") {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode("helix"); }
    return;
  }
  if (e.key === "Escape") {
    if (selected) select(null);
    else setMode("emblem");
    return;
  }
  const i = selected && layout.byPath.get(selected) ? layout.byPath.get(selected)!.index : -1;
  let next = -2;
  if (e.key === "ArrowDown" || e.key === "ArrowRight") next = Math.min(layout.nodes.length - 1, i + 1); // older
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = Math.max(0, i - 1); // newer
  if (e.key === "Home") next = 0;
  if (e.key === "End") next = layout.nodes.length - 1;
  if (next !== -2 && layout.nodes[next]) { e.preventDefault(); select(layout.nodes[next].note.path); }
});

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
window.addEventListener("resize", resize);

buildList();
resize();
setMode("emblem");
