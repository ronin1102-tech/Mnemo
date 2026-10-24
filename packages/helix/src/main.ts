import { demoData } from "./demo";
import { drawEmblem } from "./emblem";
import { QualityGovernor, TIERS, TIER_NAMES } from "./fx";
import type { Tier } from "./fx";
import { layoutGraph, layoutHelix, ROW_GAP, timeOf, withinHops } from "./layout";
import type { GraphPoint, HelixLayout } from "./layout";
import { drawBackground, drawDust, drawGraph, drawHelix, graphToScreen, helixPos, poolHit } from "./render";
import type { GraphView } from "./render";
import type { GraphData } from "./types";

type Mode = "emblem" | "helix" | "graph";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("stage");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const listEl = $<HTMLUListElement>("strand-list");
const listScroll = $<HTMLElement>("strand-scroll");
const stageWrap = document.querySelector(".stage-wrap") as HTMLElement;
const detailEl = $<HTMLElement>("detail");
const liveEl = $<HTMLElement>("live");
const sourceEl = $<HTMLElement>("source");
const tipEl = $<HTMLElement>("tip");
const hintEl = $<HTMLElement>("hint");
const fxBtn = $<HTMLButtonElement>("fx");
const segInd = $<HTMLElement>("seg-ind");

const injected = (window as unknown as { __MNEMO_GRAPH__?: GraphData }).__MNEMO_GRAPH__;
const data: GraphData = injected || demoData();
sourceEl.textContent = injected ? `Vault · ${data.nodes.length.toLocaleString()} notes · snapshot ${injected.generatedAt.slice(0, 16).replace("T", " ")}` : "Demo vault · run mnemo-ctl export-graph to load yours";
$("count").textContent = `${data.nodes.length.toLocaleString()} notes`;

const layout: HelixLayout = layoutHelix(data);
// Graph-mode layout is computed on first use, so opening the helix never pays for it.
let graphPtsCache: Map<string, GraphPoint> | null = null;
const graphPoints = () => graphPtsCache || (graphPtsCache = layoutGraph(data.nodes, data.links));
const titles = new Map(data.nodes.map((n) => [n.path, n.title]));
const notesByPath = new Map(data.nodes.map((n) => [n.path, n]));
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
const degree = new Map<string, number>([...adj].map(([p, n]) => [p, n.size]));
/** Roughly the top 8% most-linked notes are hubs (always labelled in graph mode). */
const hubDegree = (() => {
  const d = [...degree.values()].sort((a, b) => b - a);
  return Math.max(2, d[Math.floor(d.length * 0.08)] || 2);
})();
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- effects quality --------------------------------------------------------

const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const store = {
  get(k: string) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
};
/** `?fx=0..3` pins a tier (for QA measurement); otherwise Auto (governed) or Off. */
const forcedMatch = /[?&]fx=([0-3])/.exec(window.location.search);
const forced: Tier | null = forcedMatch ? (Number(forcedMatch[1]) as Tier) : null;
let fxOff = store.get("mnemo.fx") === "off";
const governor = new QualityGovernor(3, 0);
/** No judging during warm-up (load, mode switch, tab return): one slow frame must not condemn a session. */
let holdUntil = 0;
const hold = (ms = 2000) => { holdUntil = performance.now() + ms; };
const tier = (): Tier => (reduceMotion || fxOff ? 0 : forced !== null ? forced : governor.tier);
const fx = () => TIERS[tier()];

function updateFxButton() {
  const label = reduceMotion ? "Reduced motion" : fxOff ? "Off" : forced !== null ? `${TIER_NAMES[forced]} (pinned)` : `Auto · ${governor.tier === 0 ? "Static" : TIER_NAMES[governor.tier]}`;
  $("fx-label").textContent = `Effects: ${label}`;
  fxBtn.setAttribute("aria-label", `Effects: ${label}. Toggle visual effects.`);
  fxBtn.setAttribute("aria-pressed", String(!fxOff && !reduceMotion));
  fxBtn.disabled = reduceMotion;
}

// ---- state ------------------------------------------------------------------

let mode: Mode = "emblem";
let emb = 0; // 0 = emblem, 1 = full view; animated
let embTarget = 0;
let embMs = 250;
let rising = false; // the 1.2s rising transition (plays once per vault open)
let risePlayed = false;
let depth = 1; // focus hop depth, 1-3
let scrollY = 0;
let scrollTarget = 0;
let selected: string | null = null;
let selectedAt = -10;
let hover: string | null = null;
let gv: GraphView = { x: 0, y: 0, zoom: 1 };
let gvTarget: GraphView = { x: 0, y: 0, zoom: 1 };
const view: { w: number; h: number; cx: number } = { w: 0, h: 0, cx: 0 };
let cxTarget = 0;
let dpr = 1;
let raf = 0;
let lastT = 0;
let clock = 0; // seconds of animated time
let lastInput = 0;
let frameNo = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: cheap on software-rendered canvases
  const r = canvas.getBoundingClientRect();
  view.w = Math.max(1, Math.floor(r.width));
  view.h = Math.max(1, Math.floor(r.height));
  canvas.width = Math.floor(view.w * dpr);
  canvas.height = Math.floor(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scrollTarget = clamp(scrollTarget);
  scrollY = clamp(scrollY);
  cxTarget = centreTarget();
  view.cx = cxTarget;
  placeSegIndicator();
  stageWrap.classList.toggle("sheet", sheetMode());
  renderList();
  hold();
  request();
}

const maxScroll = () => Math.max(0, layout.height - view.h);
const clamp = (v: number) => Math.max(0, Math.min(maxScroll(), v));

function request() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function touch() {
  lastInput = performance.now();
  if (!hintEl.hidden) hintEl.classList.add("gone");
}

/** One frame: advance transitions and easing, draw, and keep looping only while something moves. */
function frame(ts: number) {
  raf = 0;
  const dt = lastT ? Math.min(64, ts - lastT) : 16;
  lastT = ts;
  const spec = fx();
  // calm when nobody has touched it for a while: ambient effects drop to ~30 fps
  const calm = spec.animate && ts - lastInput > 45000;
  frameNo++;
  if (calm && frameNo % 2) {
    raf = requestAnimationFrame(frame);
    return;
  }
  if (spec.animate) clock += dt / 1000;

  let moving = false;
  if (emb !== embTarget) {
    emb += Math.sign(embTarget - emb) * Math.min(Math.abs(embTarget - emb), dt / embMs);
    moving = emb !== embTarget;
    if (!moving) rising = false;
  }
  const ease = reduceMotion ? 1 : 1 - Math.exp(-dt / 90);
  if (Math.abs(scrollTarget - scrollY) > 0.3) {
    scrollY += (scrollTarget - scrollY) * ease;
    moving = true;
  } else scrollY = scrollTarget;
  if (Math.abs(gvTarget.x - gv.x) + Math.abs(gvTarget.y - gv.y) + Math.abs(gvTarget.zoom - gv.zoom) * 100 > 0.3) {
    gv = { x: gv.x + (gvTarget.x - gv.x) * ease, y: gv.y + (gvTarget.y - gv.y) * ease, zoom: gv.zoom + (gvTarget.zoom - gv.zoom) * ease };
    moving = true;
  } else gv = { ...gvTarget };

  cxTarget = centreTarget();
  if (Math.abs(cxTarget - view.cx) > 0.3) {
    view.cx += (cxTarget - view.cx) * (reduceMotion ? 1 : 1 - Math.exp(-dt / 140));
    moving = true;
  } else view.cx = cxTarget;

  const t0 = performance.now();
  draw();
  const cost = performance.now() - t0;
  if (spec.animate && !calm && ts > holdUntil && forced === null && !fxOff && !reduceMotion && governor.sample(cost, dt)) updateFxButton();

  if (moving || spec.animate) raf = requestAnimationFrame(frame);
  else lastT = 0;
}

/** Keep the coil clear of the focus card: centre it in the space to the card's right when there is room. */
/** Below this stage width the focus card becomes a bottom sheet instead of floating beside the coil. */
const SHEET_W = 900;
const sheetMode = () => view.w <= SHEET_W;

function centreTarget() {
  const card = !detailEl.hidden && mode !== "emblem" && !sheetMode();
  return card ? view.w / 2 + Math.min(200, (view.w - 760) / 2) : view.w / 2;
}

function neighbours(): Set<string> {
  return selected ? withinHops(adj, selected, depth) : EMPTY;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function draw() {
  const spec = fx();
  drawBackground(ctx, view, dpr);
  const travel = mode === "graph" ? gv.y * gv.zoom : mode === "helix" ? scrollY : 0;
  drawDust(ctx, view, clock, spec.dust, travel, 1);
  if (emb < 1) drawEmblem(ctx, view, clock, 1 + emb * 0.12, 1 - Math.min(1, emb * 1.6), spec, dpr);
  if (emb > 0) {
    if (mode === "graph") {
      drawGraph(ctx, view, { pts: graphPoints(), links: data.links, titles, selected, hover, proposed, neighbours: neighbours(), gv, t: clock, fx: spec, selectedAt, alpha: emb, degree, hubDegree });
    } else {
      const reveal = rising ? easeOut(emb) : 1;
      drawHelix(ctx, view, { layout, scrollY, selected, hover, proposed, neighbours: neighbours(), reveal, alpha: rising ? 1 : emb, t: clock, fx: spec, selectedAt });
    }
  }
  placeTip();
}

// ---- mode, selection ----------------------------------------------------

function setMode(m: Mode) {
  mode = m;
  hold();
  embTarget = m === "emblem" ? 0 : 1;
  // The rise plays once, when the vault is first opened; later switches are a quick crossfade.
  rising = m === "helix" && !risePlayed && !reduceMotion && emb < 1;
  if (m !== "emblem") risePlayed = true;
  embMs = rising ? 1200 : 300;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg [data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  placeSegIndicator();
  canvas.setAttribute("aria-label", canvasLabel());
  document.body.setAttribute("data-mode", m);
  if (m === "graph" && !graphFitted) fitGraph();
  if (m === "emblem") hideDetail();
  else if (selected) showDetail(selected);
  hover = null;
  request();
}

let graphFitted = false;
/** Frame the whole graph in the stage the first time graph mode opens. */
function fitGraph() {
  graphFitted = true;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of graphPoints().values()) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!isFinite(x0)) return;
  const zoom = Math.max(0.2, Math.min(3, (view.w - 260) / Math.max(1, x1 - x0), (view.h - 160) / Math.max(1, y1 - y0)));
  gvTarget = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom };
  gv = { ...gvTarget, zoom: zoom * 0.8 }; // a gentle settle-in
}

function placeSegIndicator() {
  const b = document.querySelector<HTMLButtonElement>(`.seg [data-mode="${mode}"]`);
  if (!b) return;
  segInd.style.width = b.offsetWidth + "px";
  segInd.style.transform = `translateX(${b.offsetLeft}px)`;
}

function canvasLabel() {
  const what = mode === "graph" ? "Graph" : "Helix";
  return mode === "emblem"
    ? "Mnemo emblem. Press Enter to open the helix."
    : `${what} of ${data.nodes.length} notes. Use arrow keys to move between notes; the strand list beside it has the same content.`;
}

function select(path: string | null, reveal = true) {
  selected = path;
  selectedAt = clock;
  touch();
  const idx = path && layout.byPath.get(path) ? layout.byPath.get(path)!.index : -1;
  if (idx >= 0 && reveal) revealRow(idx);
  renderList();
  if (path && reveal) {
    // with the card as a bottom sheet, sit the note in the upper part of the view, clear of it
    const at = path && mode !== "emblem" && sheetMode() ? 0.28 : 0.5;
    if (mode === "graph") {
      const p = graphPoints().get(path);
      if (p) gvTarget = { ...gvTarget, x: p.x, y: p.y + ((0.5 - at) * view.h) / gvTarget.zoom };
    } else {
      const n = layout.byPath.get(path);
      if (n) scrollTarget = clamp(n.y - view.h * at);
    }
  }
  if (path && mode !== "emblem") showDetail(path);
  else hideDetail();
  request();
}

// ---- focus card ---------------------------------------------------------------

function showDetail(path: string) {
  const note = notesByPath.get(path);
  if (!note) return;
  const out = data.links.filter((l) => l.src === path && titles.has(l.dst)).map((l) => l.dst);
  const inn = data.links.filter((l) => l.dst === path && titles.has(l.src)).map((l) => l.src);
  const props = data.proposals.filter((p) => p.path === path);
  detailEl.innerHTML = "";
  const close = el("button", "card-close", "×");
  close.setAttribute("aria-label", "Close focus");
  (close as HTMLButtonElement).type = "button";
  close.addEventListener("click", () => select(null));
  detailEl.appendChild(close);
  detailEl.appendChild(el("p", "eyebrow", `${dateOf(timeOf(note))} · ${inn.length} backlink${inn.length === 1 ? "" : "s"} · ${out.length} link${out.length === 1 ? "" : "s"}`));
  detailEl.appendChild(el("h2", "card-title", note.title));
  detailEl.appendChild(el("p", "card-path", note.path));
  if (note.excerpt) detailEl.appendChild(el("p", "excerpt", note.excerpt));
  if (note.tags.length) {
    const tags = el("div", "tags", "");
    for (const t of note.tags) tags.appendChild(el("span", "tag", "#" + t));
    detailEl.appendChild(tags);
  }
  for (const p of props) detailEl.appendChild(el("p", "proposal proposal-note", `An agent (${p.client}) proposes to ${p.op} this note. Review: mnemo-ctl show ${p.id}`));
  detailEl.appendChild(depthControl(path));
  const cols = el("div", "link-cols", "");
  cols.appendChild(linkGroup("Links to", out));
  cols.appendChild(linkGroup("Linked from", inn));
  detailEl.appendChild(cols);
  if (detailEl.hidden) {
    detailEl.hidden = false;
    detailEl.classList.remove("open");
    requestAnimationFrame(() => detailEl.classList.add("open"));
  }
  liveEl.textContent = `Selected ${note.title}. ${out.length} outgoing, ${inn.length} incoming links.`;
}

/** Focus depth: how many link-hops stay lit around the selection. */
function depthControl(path: string) {
  const wrap = el("div", "depth", "");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Focus depth");
  wrap.appendChild(el("span", "depth-label", "Depth"));
  for (const n of [1, 2, 3]) {
    const b = el("button", "", String(n)) as HTMLButtonElement;
    b.type = "button";
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
  detailEl.classList.remove("open");
  detailEl.hidden = true;
  detailEl.innerHTML = "";
}

function el(tag: string, cls: string, text: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

function linkGroup(label: string, paths: string[]) {
  const wrap = el("div", "link-group", "");
  wrap.appendChild(el("h3", "", `${label} · ${paths.length}`));
  const ul = document.createElement("ul");
  for (const p of paths.slice(0, 40)) {
    const li = document.createElement("li");
    const b = el("button", "linkbtn", titles.get(p) || p) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => select(p));
    li.appendChild(b);
    ul.appendChild(li);
  }
  if (paths.length > 40) ul.appendChild(el("li", "more", `+ ${paths.length - 40} more`));
  if (!paths.length) ul.appendChild(el("li", "none", "None"));
  wrap.appendChild(ul);
  return wrap;
}

// ---- hover tooltip ----------------------------------------------------------------

function setHover(h: string | null) {
  if (h === hover) return;
  hover = h;
  canvas.style.cursor = h ? "pointer" : mode === "emblem" ? "pointer" : "grab";
  if (h && h !== selected) {
    const n = notesByPath.get(h)!;
    tipEl.innerHTML = "";
    tipEl.appendChild(el("strong", "", n.title));
    tipEl.appendChild(el("span", "", `${dateOf(timeOf(n))} · ${(adj.get(h) || EMPTY).size} links${proposed.has(h) ? " · proposal pending" : ""}`));
    tipEl.hidden = false;
  } else tipEl.hidden = true;
  request();
}

function placeTip() {
  if (tipEl.hidden || !hover) return;
  let p: { x: number; y: number } | null = null;
  if (mode === "graph") {
    const g = graphPoints().get(hover);
    if (g) p = graphToScreen(view, gv, g);
  } else if (mode === "helix") {
    const n = layout.byPath.get(hover);
    if (n) p = helixPos(n, view, scrollY);
  }
  if (!p) return;
  const right = p.x < view.w - 260;
  tipEl.style.transform = `translate(${Math.round(right ? p.x + 18 : p.x - 18 - tipEl.offsetWidth)}px, ${Math.round(p.y + 14)}px)`;
}

// ---- strand list (the accessible twin) ----------------------------------------

/**
 * The strand list is windowed: only rows near the viewport (plus the selected and focused rows)
 * exist in the DOM. At 10k notes the full list was 70,000 elements; on a 6x-throttled CPU that
 * meant an 8 s page load and 10 fps list scrolling. Each row carries aria-setsize/aria-posinset,
 * and arrow keys walk all notes. Small vaults (up to FULL_LIST_MAX) still render every row, so
 * the list stays complete for screen readers in browse mode.
 */
const ROW_H = 48;
const FULL_LIST_MAX = 1500;
const rows = new Map<number, HTMLLIElement>();
let listFocus = -1;
let listRaf = 0;

function makeRow(i: number): HTMLLIElement {
  const n = layout.nodes[i];
  const li = document.createElement("li");
  li.style.transform = `translateY(${i * ROW_H}px)`;
  li.setAttribute("aria-setsize", String(layout.nodes.length));
  li.setAttribute("aria-posinset", String(i + 1));
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.path = n.note.path;
  b.dataset.index = String(i);
  b.className = "row s" + n.strand;
  const deg = (adj.get(n.note.path) || EMPTY).size;
  const prop = proposed.has(n.note.path);
  b.setAttribute("aria-label", `${n.note.title}, ${dateOf(timeOf(n.note))}, ${deg} links${prop ? ", has a pending agent proposal" : ""}`);
  b.appendChild(el("span", "rail", ""));
  const body = el("span", "row-body", "");
  body.appendChild(el("span", "row-title", n.note.title));
  body.appendChild(el("span", "row-date", dateOf(timeOf(n.note))));
  b.appendChild(body);
  if (prop) b.appendChild(el("span", "proposal badge", "proposal"));
  b.appendChild(el("span", "pill", String(deg)));
  li.appendChild(b);
  return li;
}

/** Bring the rendered rows in line with the list's scroll position. Existing rows are never moved, so focus survives. */
function renderList() {
  const total = layout.nodes.length;
  listEl.style.height = total * ROW_H + "px";
  let first = 0;
  let last = total - 1;
  if (total > FULL_LIST_MAX) {
    first = Math.max(0, Math.floor(listScroll.scrollTop / ROW_H) - 15);
    last = Math.min(total - 1, first + Math.ceil((listScroll.clientHeight || 600) / ROW_H) + 30);
  }
  const want = new Set<number>();
  for (let i = first; i <= last; i++) want.add(i);
  const sel = selected && layout.byPath.get(selected) ? layout.byPath.get(selected)!.index : -1;
  if (sel >= 0) want.add(sel);
  if (listFocus >= 0) want.add(listFocus);
  for (const [i, li] of rows) if (!want.has(i)) { li.remove(); rows.delete(i); }
  // insert new rows in index order, before the next existing row, without touching existing ones
  const order = [...want].sort((a, b) => a - b);
  let next: Node | null = null;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    let li = rows.get(i);
    if (!li) {
      li = makeRow(i);
      rows.set(i, li);
      listEl.insertBefore(li, next);
    }
    next = li;
  }
  for (const [i, li] of rows) {
    const b = li.firstChild as HTMLElement;
    if (i === sel) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}

/** Scroll the list so row i is visible (centred if it was off-screen). */
function revealRow(i: number) {
  const top = i * ROW_H;
  const h = listScroll.clientHeight;
  if (top < listScroll.scrollTop || top + ROW_H > listScroll.scrollTop + h) listScroll.scrollTop = top - h / 2 + ROW_H / 2;
}

function focusRow(i: number) {
  const total = layout.nodes.length;
  i = Math.max(0, Math.min(total - 1, i));
  listFocus = i;
  revealRow(i);
  renderList();
  (rows.get(i)!.firstChild as HTMLElement).focus();
}

listScroll.addEventListener("scroll", () => {
  if (!listRaf) listRaf = requestAnimationFrame(() => { listRaf = 0; renderList(); });
}, { passive: true } as AddEventListenerOptions);
listEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-index]") as HTMLElement | null;
  if (!b) return;
  if (mode === "emblem") setMode("helix");
  select(layout.nodes[Number(b.dataset.index)].note.path);
});
listEl.addEventListener("keydown", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-index]") as HTMLElement | null;
  if (!b) return;
  const i = Number(b.dataset.index);
  const page = Math.max(1, Math.floor(listScroll.clientHeight / ROW_H) - 1);
  const to: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + page, PageUp: i - page, Home: 0, End: layout.nodes.length - 1 };
  if (e.key in to) {
    e.preventDefault();
    focusRow(to[e.key]);
  }
});
listEl.addEventListener("focusin", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-index]") as HTMLElement | null;
  if (b) listFocus = Number(b.dataset.index);
});
listEl.addEventListener("focusout", (e) => {
  if (!e.relatedTarget || !listEl.contains(e.relatedTarget as Node)) {
    listFocus = -1;
    if (!listRaf) listRaf = requestAnimationFrame(() => { listRaf = 0; renderList(); });
  }
});

// ---- pointer / keyboard -------------------------------------------------------

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
  if (mode !== "helix") return null;
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
document.addEventListener("keydown", () => { skipRise(); touch(); }, true);

canvas.addEventListener("pointerdown", (e) => {
  skipRise();
  touch();
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
    if (mode === "graph") {
      gvTarget = { ...gvTarget, x: gvTarget.x - dx / gv.zoom, y: gvTarget.y - dy / gv.zoom };
      gv = { ...gvTarget, zoom: gv.zoom };
    } else if (mode === "helix") {
      scrollTarget = clamp(scrollTarget - dy);
      scrollY = scrollTarget;
    }
    touch();
    request();
  } else if (mode !== "emblem") {
    setHover(pick(e.clientX - r.left, e.clientY - r.top));
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
    scrollTarget = 0;
    return request();
  }
  setHover(null);
  select(hit, false);
});
canvas.addEventListener("pointerleave", () => setHover(null));
canvas.addEventListener("wheel", (e) => {
  if (mode === "emblem") return;
  e.preventDefault();
  touch();
  if (mode === "graph") {
    const z = Math.max(0.2, Math.min(4, gvTarget.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    gvTarget = { ...gvTarget, zoom: z };
  } else {
    scrollTarget = clamp(scrollTarget + e.deltaY * (e.deltaMode === 1 ? 36 : 1));
    if (reduceMotion) scrollY = scrollTarget;
  }
  setHover(null);
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== canvas && selected) select(null);
});

for (const b of document.querySelectorAll<HTMLButtonElement>(".seg [data-mode]")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}
fxBtn.addEventListener("click", () => {
  fxOff = !fxOff;
  store.set("mnemo.fx", fxOff ? "off" : "auto");
  updateFxButton();
  request();
});
window.addEventListener("resize", resize);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastT = 0; hold(); request(); } });

updateFxButton();
resize();
setMode("emblem");
