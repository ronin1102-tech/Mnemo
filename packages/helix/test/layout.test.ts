import { describe, expect, it } from "vitest";
import { ROW_GAP, layoutGraph, layoutHelix, strandX, visibleRange } from "../src/layout";
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
  it("alternates strands", () => expect(l.nodes.map((n) => n.strand)).toEqual([0, 1, 0]));
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
