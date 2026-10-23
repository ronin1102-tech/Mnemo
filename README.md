# Mnemo

A local-first second brain. Notes are plain `.md` files in a folder you own; an MCP server lets AI agents read them and *propose* changes; a human decides what lands.

## Packages

| Package | What it is |
| --- | --- |
| `packages/mnemo-mcp` | MCP server (TypeScript, stdio only: no ports, no network) and the human CLI |
| `packages/helix` | Helix UI: Canvas 2D view of the vault, built to hold ~60fps on Safari 13 (macOS 10.15) |

```
npm run install:all && npm run build && npm test
```

## MCP server

```
node packages/mnemo-mcp/dist/cli.js --vault ~/notes serve
```

MCP client config: `{"command":"node","args":[".../dist/cli.js","--vault","/path/to/vault","serve"]}`.

**Read tools:** `search_notes` (SQLite FTS5), `read_note`, `list_recent`, `list_notes`, `get_backlinks`, `daily_note` (read-only; `daily/YYYY-MM-DD.md`).
**Write tools:** `propose_write`, `propose_append`, `propose_delete`, plus `list_proposals`. These never touch a note.

Safety model:

- **Vault jail:** vault-relative `.md` paths only. Absolute paths, `..`, `.mnemo/`, and any symlink on the path are rejected.
- **Write gate:** an agent write saves a proposal (diff, client name, timestamp) to `.mnemo/proposals/`. Only the human CLI applies it:
  `mnemo-mcp --vault V proposals list | show <id> | approve <id> | reject <id>`. Approval is refused if the note changed since it was proposed. There is no bypass flag and no approve tool over MCP.
- **Expiry:** pending proposals expire after 7 days.
- **Deletion:** an approved agent delete moves the note to `.mnemo/trash/`. Only `mnemo-mcp purge-trash` (human) destroys files.
- The SQLite index and logs live in `.mnemo/`; the index is a cache and rebuilds itself.

## Helix UI

```
node packages/mnemo-mcp/dist/cli.js --vault ~/notes export-graph --out packages/helix/dist/graph.js
open packages/helix/dist/index.html
```

Without `graph.js` it shows demo data. Views: **Emblem** (collapsed mark, Enter/click to open), **Helix** (newest at top, oldest at bottom; each `[[wikilink]]` is a rung between its two notes), **Graph** (read-only). The strand list beside the canvas is the accessible equivalent, and arrow keys move between notes. Rows are spaced by rank, not wall-clock time, so bursts of notes never overlap.

**Colour:** gold marks agent proposals only. A test fails if gold is used anywhere else.

## Not in V1 (planned V1.1)

Similarity arcs and Structural Similarity, the gold proposal pulse with in-view approval, strand filters, tag tints. The packaged standalone app shell (e.g. Electron/Tauri) is also not built yet; today the UI is a static page.
