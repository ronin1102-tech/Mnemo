import type { GraphData } from "./types";

/** Shown only when no graph.js from `mnemo-ctl export-graph` is present. */
export function demoData(): GraphData {
  const titles = ["Mnemo", "Helix UI", "Write gate", "Vault jail", "FTS5 index", "Daily 2026-10-20", "Daily 2026-10-21", "Daily 2026-10-22",
    "Reading list", "Catalina notes", "Canvas perf", "Wikilinks", "Backlinks", "Proposal expiry", "Trash policy", "Inbox", "Ideas", "Meeting notes"];
  const base = Date.UTC(2026, 9, 23);
  const nodes = titles.map((t, i) => ({ path: t + ".md", title: t, mtime: base - i * 86400000 * 1.7, tags: [] }));
  const p = (i: number) => nodes[i].path;
  const pairs = [[0, 1], [0, 2], [2, 3], [0, 4], [5, 0], [6, 0], [7, 1], [1, 10], [9, 10], [11, 12], [12, 0], [2, 13], [2, 14], [15, 0], [16, 1], [17, 5], [8, 16], [4, 11]];
  const links = pairs.map(([a, b]) => ({ src: p(a), dst: p(b) }));
  // the demo carries whole notes so the reader works without a vault; live mode fetches them instead
  const content = new Map<string, string>([[p(0), MNEMO_NOTE]]);
  for (const n of nodes) {
    if (content.has(n.path)) continue;
    const out = links.filter((l) => l.src === n.path).map((l) => `[[${titles[nodes.findIndex((m) => m.path === l.dst)]}]]`);
    content.set(n.path, `# ${n.title}\n\nA demo note in the Mnemo demo vault.${out.length ? ` It links to ${out.join(" and ")}.` : ""}\n\nOpen your own vault with **mnemo-ctl ui** (or Mnemo.app) to read your notes here.\n`);
  }
  for (const n of nodes) (n as { content?: string }).content = content.get(n.path);
  (nodes[0] as { tags: string[] }).tags = ["mnemo", "overview"];
  return { generatedAt: new Date(base).toISOString(), nodes, links, proposals: [{ id: "demo", path: p(13), op: "write", client: "demo-agent" }] };
}

const MNEMO_NOTE = `---
tags: [mnemo, overview]
---
# Mnemo

Mnemo is a **local-first second brain**: plain Markdown files in a folder you own, an index that makes them searchable, and a gate that keeps agents honest. It grew out of the [[Helix UI]] and the [[Write gate]].

## How it fits together

1. Notes live in the vault as \`.md\` files, so nothing is locked in.
2. The [[FTS5 index]] keeps search fast, even at 10,000 notes.
3. Agents talk to it over MCP; every write they ask for becomes a *proposal*.

> [!note] The one rule
> Agents propose. People decide. Nothing an agent writes reaches the vault until someone approves it.

### What an agent can do

| Tool | Effect |
|:--|:--|
| \`read_note\` | Reads a note |
| \`write_note\` | Proposes a new version |
| \`delete_note\` | Proposes moving it to the trash |

### This week

- [x] Connect Cori over MCP
- [x] Connect Vesper through the custom connector
- [ ] Try the reader on a long note
  - with headings, lists and ==highlights==

> Memory is the treasury and guardian of all things. — Cicero

\`\`\`sh
mnemo-ctl ui --vault ~/Mnemo-Vault
\`\`\`

See also [[Vault jail#Symlinks|how the jail works]], #mnemo and [the MCP spec](https://modelcontextprotocol.io).
`;
