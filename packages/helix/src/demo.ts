import type { GraphData } from "./types";

/** Shown only when no graph.js from `mnemo-ctl export-graph` is present. */
export function demoData(): GraphData {
  const titles = ["Mnemo", "Helix UI", "Write gate", "Vault jail", "FTS5 index", "Daily 2026-10-20", "Daily 2026-10-21", "Daily 2026-10-22",
    "Reading list", "Catalina notes", "Canvas perf", "Wikilinks", "Backlinks", "Proposal expiry", "Trash policy", "Inbox", "Ideas", "Meeting notes"];
  const base = Date.UTC(2026, 9, 23);
  const nodes = titles.map((t, i) => ({ path: t.toLowerCase().replace(/\W+/g, "-") + ".md", title: t, mtime: base - i * 86400000 * 1.7, tags: [] }));
  const p = (i: number) => nodes[i].path;
  const pairs = [[0, 1], [0, 2], [2, 3], [0, 4], [5, 0], [6, 0], [7, 1], [1, 10], [9, 10], [11, 12], [12, 0], [2, 13], [2, 14], [15, 0], [16, 1], [17, 5], [8, 16], [4, 11]];
  return { generatedAt: new Date(base).toISOString(), nodes, links: pairs.map(([a, b]) => ({ src: p(a), dst: p(b) })), proposals: [{ id: "demo", path: p(13), op: "write", client: "demo-agent" }] };
}
