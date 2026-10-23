# Mnemo

A local-first second brain. Notes are plain `.md` files in a folder you own; an MCP server lets AI agents read them and *propose* changes; a human decides what lands.

## Packages

| Package | What it is |
| --- | --- |
| `packages/mnemo-mcp` | MCP server (TypeScript, stdio only: no ports, no network) and `mnemo-ctl`, the human admin CLI |
| `packages/helix` | Helix UI: Canvas 2D view of the vault, built to hold ~60fps on Safari 13 (macOS 10.15) |

```
npm run install:all && npm run build && npm test
```

## MCP server

```
node packages/mnemo-mcp/dist/cli.js --vault ~/notes serve
```

MCP client config: `{"command":"node","args":[".../dist/cli.js","--vault","/path/to/vault","serve"]}`.

**Read tools:** `search_notes` (FTS5 BM25 over title, tags and body; filters `folder`, `tag`, `after`, `before`), `read_note` (content, parsed frontmatter, outgoing links, backlinks), `list_recent`, `list_notes` (sub-folders with counts), `get_backlinks` (with the linking line), `get_neighbors` (links in/out, unresolved, unlinked `related` notes, N-hop nodes and edges), `find_similar` (structural: shared outgoing links, shared linkers, shared tags, direct link, folder; returns a 0..1 score and reasons), `get_tags`, `daily_note` (read-only; `daily/YYYY-MM-DD.md`), `list_proposals`.
**Write tools (all gated, none touch a note):** `write_note`, `append_note`, `patch_note` (the anchor must match exactly once; zero or several matches fail closed), `move_note` (inbound `[[wikilinks]]` are rewritten in the same proposal), `delete_note`.
`serve --read-only` (or `MNEMO_READ_ONLY=1`) registers no write tools at all.

Safety model:

- **Vault jail:** vault-relative `.md` paths only. Absolute paths, `..`, `.mnemo/`, and any symlink on the path are rejected.
- **Write gate:** an agent write saves a proposal (diff, client name, timestamp) to `.mnemo/proposals/`. There is no approve tool over MCP and no bypass flag.
- **Stale halt:** every note a proposal depends on is hash-checked at approval. If any changed (or a move's destination now exists), the proposal becomes `stale`, nothing is applied, and the agent must re-propose.
- **Atomic writes:** temp file in the same directory, `fsync`, `rename`, then `fsync` of the directory.
- **Audit:** every settled proposal records `settledBy` (actor `mnemo-ctl` plus the OS username, or actor `expiry`) and `resolvedAt`, alongside the proposing `client`. There is no user system; proposer-versus-settler is the point.
- **Expiry:** pending proposals expire after 7 days.
- **Deletion:** an approved agent delete moves the note to `.mnemo/trash/`. Only `mnemo-ctl purge-trash` destroys files.
- The SQLite index and logs live in `.mnemo/`; the index is a cache and rebuilds itself.

## mnemo-ctl (human only, never exposed over MCP)

```
mnemo-ctl --vault V list [status] | show <id> | approve <id> | reject <id> | reindex | purge-trash | export-graph [--out f.js]
```

`--read-only` makes `approve`, `reject` and `purge-trash` refuse. Note: this is a convention for the human operator, not a sandbox. An agent that is also given a shell can run `mnemo-ctl` itself, so don't give the same agent both.

**Vault conventions:** optional YAML frontmatter (`title`, `created`, `tags` as `[a, b]`, `a, b` or a `- a` list) is read and never rewritten; inline `#tags` also count. Edges are `[[wikilinks]]` and relative `[text](note.md)` links. `move_note` rewrites both kinds in other notes. Links *inside the moved note itself* are not re-based if it changes directory. Notes over 10 MB are readable but not patchable.

## Budgets (`npm --prefix packages/mnemo-mcp run bench`, 10,000 notes)

| Budget | Target | Measured |
| --- | --- | --- |
| Server start (spawn to initialized) | < 1 s | ~0.2 s |
| Search p95 (includes the per-call disk sync) | < 200 ms | ~80-100 ms |
| Cold index build | < 30 s | ~1.2 s |
| Idle memory | < 128 MB | ~111 MB |

The memory target was raised from 50 MB: a bare Node process is 42 MB and the official MCP SDK adds ~22 MB before SQLite, zod or any data (about 76 MB with an empty vault).

## Helix UI

```
node packages/mnemo-mcp/dist/ctl.js --vault ~/notes export-graph --out packages/helix/dist/graph.js
open packages/helix/dist/index.html
```

Without `graph.js` it shows demo data. Palette is the mark's: deep navy, water-blue strands, blue-white nodes.

- **Emblem mode:** the mark itself (gold ring, coil rising from the pool, gold beads). Opening the helix plays the ~1.2 s **rising transition** once per page load: the coil climbs out of the water and nodes light from the bottom up. Any key or click skips it; `prefers-reduced-motion` gets a short crossfade only.
- **Helix mode:** time is the vertical axis, newest at the top, oldest at the bottom, where the coil narrows into **the spring** (the pool; click it to clear focus and return to the newest end). Position is measured from the spring, so adding notes only extends the coil upward and never moves existing nodes. A note's time is frontmatter `created` when present, else modified time. Rows are spaced by rank, not clock time.
- **Strands are link partners:** notes are placed oldest-first, each on the strand opposite its strongest already-placed link partner (most shared neighbours, then most recent), so links become rungs. Existing placements never change when newer notes arrive.
- **Focus:** click a node (or use the strand list / arrow keys) to centre it, brighten its rungs and dim everything outside 1, 2 or 3 link-hops. The card shows title, excerpt, tags, backlink count and links. Esc clears focus, a second Esc returns to the emblem.
- **Graph mode** (read-only; force layout up to 2,000 notes, a deterministic time-ordered spiral above that so a 10k vault opens instantly; computed on first use) and the **strand list** (a keyboard- and screen-reader-complete twin of the same data) are also available.
- **Colour:** gold marks agent proposals only. The emblem's own gold (`markGold`) is a branding surface, used only inside the emblem renderer; tests enforce both rules.

## Not in V1 (planned V1.1)

Similarity arcs in the UI, the gold proposal pulse with in-view approval, strand filters, tag tints, spatial search lighting, re-basing relative links inside a moved note, a journal/resume for multi-file moves. The packaged standalone app shell (e.g. Electron/Tauri) is also not built yet; today the UI is a static page.
