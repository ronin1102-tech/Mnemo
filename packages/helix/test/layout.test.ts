import { describe, expect, it } from "vitest";
import { ROW_GAP, assignStrands, layoutGraph, layoutHelix, strandX, visibleRange } from "../src/layout";
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
  it("puts newest at the top and oldest at the bottom", () => {
    expect(l.nodes.map((n) => n.note.path)).toEqual(["new.md", "mid.md", "old.md"]);
    expect(l.nodes[0].y).toBeLessThan(l.nodes[2].y);
    expect(l.nodes[1].y - l.nodes[0].y).toBe(ROW_GAP);
  });
  it("linked notes sit on opposite strands", () => {
    const strandOf = (p: string) => l.byPath.get(p)!.strand;
    expect(strandOf("new.md")).not.toBe(strandOf("old.md"));
  });
  it("chains alternate and unlinked notes balance the strands", () => {
    const chain = assignStrands(6, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
    expect(chain.every((s, i) => i === 0 || s !== chain[i - 1])).toBe(true);
    const lone = assignStrands(10, []);
    expect(lone.filter((s) => s === 0).length).toBe(5);
    const star = assignStrands(5, [[0, 1], [0, 2], [0, 3], [0, 4]]);
    expect(star.slice(1).every((s) => s !== star[0])).toBe(true);
  });
  it("keeps one rung per linked pair, dropping dangling and self links", () => {
    expect(l.rungs).toHaveLength(1);
    expect(l.rungs[0].map((n) => n.note.path).sort()).toEqual(["new.md", "old.md"]);
  });
  it("strands are mirror images", () => expect(strandX(50, 0)).toBeCloseTo(-strandX(50, 1)));
  it("visibleRange clamps and culls", () => {
    expect(visibleRange(1000, 0, 100)[0]).toBe(0);
    const [a, b] = visibleRange(1000, 5000, 5400);
    expect(a).toBeGreaterThan(100);
    expect(b - a).toBeLessThan(25);
    expect(visibleRange(3, 0, 1e6)[1]).toBe(2);
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
