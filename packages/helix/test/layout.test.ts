import { describe, expect, it } from "vitest";
import { ROW_GAP, assignStrands, layoutGraph, layoutHelix, radiusAt, strandX, visibleRange, withinHops } from "../src/layout";
import type { GraphData } from "../src/types";

const note = (path: string, mtime: number) => ({ path, title: path, mtime, tags: [] });
const data: GraphData = {
  generatedAt: "",
  nodes: [note("old.md", 1), note("mid.md", 2), note("new.md", 3)],
  links: [
    { src: "new.md", dst: "old.md" },
    { src: "old.md", dst: "new.md" }, // duplicate, reversed
    { src: "new.md", dst: "ghost.md" }, // dangling
    { src: "mid.md", dst: "mid.md" }, // self
  ],
  proposals: [],
};

describe("helix layout", () => {
  const l = layoutHelix(data);
  it("puts newest at the top and oldest at the bottom, with the spring below", () => {
    expect(l.nodes.map((n) => n.note.path)).toEqual(["new.md", "mid.md", "old.md"]);
    expect(l.nodes[0].y).toBeLessThan(l.nodes[2].y);
    expect(l.nodes[1].y - l.nodes[0].y).toBe(ROW_GAP);
    expect(l.poolY).toBeGreaterThan(l.nodes[2].y);
    expect(l.nodes[2].d).toBe(0);
  });
  it("orders by frontmatter created when present, else mtime", () => {
    const g = layoutHelix({ ...data, nodes: [note("a.md", 100), { ...note("b.md", 1), created: 500 }, note("c.md", 300)] });
    expect(g.nodes.map((n) => n.note.path)).toEqual(["b.md", "c.md", "a.md"]);
  });
  it("linked notes sit on opposite strands", () => {
    const strandOf = (p: string) => l.byPath.get(p)!.strand;
    expect(strandOf("new.md")).not.toBe(strandOf("old.md"));
  });
  it("chains alternate, hubs face their leaves, unlinked notes balance the strands", () => {
    const chain = assignStrands(6, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
    expect(chain.every((s, i) => i === 0 || s !== chain[i - 1])).toBe(true);
    const lone = assignStrands(10, []);
    expect(lone.filter((s) => s === 0).length).toBe(5);
    const star = assignStrands(5, [[4, 0], [4, 1], [4, 2], [4, 3]]); // oldest note is the hub
    expect(star.slice(0, 4).every((s) => s !== star[4])).toBe(true);
  });
  it("keeps one rung per linked pair, dropping dangling and self links", () => {
    expect(l.rungs).toHaveLength(1);
    expect(l.rungs[0].map((n) => n.note.path).sort()).toEqual(["new.md", "old.md"]);
  });
  it("LAYOUT STABILITY: adding newer notes never moves or re-flips existing ones", () => {
    const base: GraphData = { generatedAt: "", nodes: [], links: [], proposals: [] };
    for (let i = 0; i < 40; i++) base.nodes.push(note(`n${i}.md`, 1000 + i));
    for (let i = 3; i < 40; i++) base.links.push({ src: `n${i}.md`, dst: `n${(i * 7) % i}.md` });
    const before = layoutHelix(base);
    const grown: GraphData = {
      ...base,
      nodes: [...base.nodes, note("n40.md", 2000), note("n41.md", 2001)],
      links: [...base.links, { src: "n40.md", dst: "n5.md" }, { src: "n41.md", dst: "n40.md" }, { src: "n41.md", dst: "n12.md" }],
    };
    const after = layoutHelix(grown);
    for (const n of before.nodes) {
      const m = after.byPath.get(n.note.path)!;
      expect(m.strand).toBe(n.strand);
      expect(m.d).toBe(n.d); // distance from the spring, i.e. the coil phase
    }
  });
  it("strands are mirror images", () => expect(strandX(50, 0)).toBeCloseTo(-strandX(50, 1)));
  it("the coil narrows into the spring below the oldest note", () => {
    expect(Math.abs(strandX(-100, 0))).toBeLessThan(Math.abs(strandX(100, 0)) + 70);
    expect(radiusAt(-1000)).toBeLessThan(radiusAt(0) * 0.2);
  });
  it("visibleRange clamps, culls and caps at 1000 nodes", () => {
    const big = layoutHelix({ generatedAt: "", nodes: Array.from({ length: 3000 }, (_, i) => note(`n${i}.md`, i)), links: [], proposals: [] });
    expect(visibleRange(big, 0, 100)[0]).toBe(0);
    const [a, b] = visibleRange(big, 5000, 5400);
    expect(a).toBeGreaterThan(100);
    expect(b - a).toBeLessThan(25);
    const [c, d] = visibleRange(big, 0, 1e7);
    expect(d - c + 1).toBe(1000);
    expect(visibleRange(l, 0, 1e6)[1]).toBe(2);
  });
  it("withinHops follows links to the requested depth", () => {
    const adj = new Map<string, Set<string>>([["a", new Set(["b"])], ["b", new Set(["a", "c"])], ["c", new Set(["b", "d"])], ["d", new Set(["c"])]]);
    expect([...withinHops(adj, "a", 1)].sort()).toEqual(["a", "b"]);
    expect([...withinHops(adj, "a", 3)].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("graph layout", () => {
  it("is deterministic and places every node", () => {
    const a = layoutGraph(data.nodes, data.links);
    const b = layoutGraph(data.nodes, data.links);
    expect(a.size).toBe(3);
    expect(a.get("new.md")).toEqual(b.get("new.md"));
    expect(Number.isFinite(a.get("old.md")!.x)).toBe(true);
  });
});

describe("layout at scale", () => {
  it("lays out 10,000 notes / 40,000 links well under a second", () => {
    const nodes = Array.from({ length: 10000 }, (_, i) => note(`n${i}.md`, i));
    const links = Array.from({ length: 40000 }, (_, i) => ({ src: `n${i % 10000}.md`, dst: `n${(i * 7919 + 13) % 10000}.md` }));
    const t = Date.now();
    const l = layoutHelix({ generatedAt: "", nodes, links, proposals: [] });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(l.nodes).toHaveLength(10000);
  });
});
