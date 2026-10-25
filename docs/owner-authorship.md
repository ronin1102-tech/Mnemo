# Owner authorship ("The Owner's Chair")

Scope: Vesper's scoping note of Oct 25, 2026. Tracy's decisions, also Oct 25:

| Question | Decision |
|---|---|
| Owner writes: instant, or a draft mode? | **Instant.** A save names the version it was edited from. If the note changed on disk since then, nothing is written and the owner chooses: keep theirs, or load the disk version. |
| Owner proposals: requests only, or also verbatim drafts? | **Requests only.** Agents answer with ordinary gated proposals. |
| Where requests live | **A `Requests/` folder** of plain `.md` notes. This is the one mechanism. |
| Who can write from the Helix | **Only the Helix on the vault's own computer.** Person keys on the tailnet can read and settle, but not write. |

## Part 1: the owner's notes

- In the Helix **Read** tab, the owner has three actions: **+ Note**, **+ Request** and **Edit**. The editor takes plain Markdown in a text box and has a Preview. Ctrl/⌘ S saves; Esc cancels and asks first if anything is unsaved.
- **Writing:** saves go to `PUT /api/note` on the bridge. That calls `Vault.atomicWrite`, the same temp → fsync → rename writer that approvals use. There is no second write path. The index picks the change up on the next sync, as it does with any disk edit.
- **Who may write:** a save is accepted only from the local session key, over loopback, and never in `--read-only` mode. Person keys get 403. The data the Helix loads tells it whether to show the editor (`canWrite`).
- **Attribution:** every owner write is logged to `.mnemo/logs/mnemo.log` as `owner-write`, with the action (`create` or `edit`), the path, the size, and `by: { actor: "helix", user }`.
- **Text is kept exactly:** the editor holds the whole file, frontmatter included, and saves exactly what was typed. A new note is `# <title>` followed by the body.
- **Conflict with agents:** a pending agent proposal on a note the owner edits goes `stale` when someone settles it, through the existing halt. The owner's bytes stay.

## Part 2: requests (intent, not bytes)

- A request is a note in `Requests/` (any letter case), written by the owner.
- **Agents can read requests, never change them.** The proposal store refuses every agent write, append, patch, delete or move whose path is in `Requests/`, including moves into or out of the folder. When an agent moves a note, link rewriting skips files in `Requests/` (a basename wikilink still resolves).
- `list_requests` is a read-only MCP tool. It returns each request's `path`, `title`, `created`, `status`, and the proposals that answer it.
- **How agents answer:** every write tool takes an optional `request` argument (the request's path). The proposal records it, and `mnemo-ctl show` prints it.
- **Status is worked out from the proposals**, so request files are never rewritten:

  | Status | Meaning |
  |---|---|
  | `open` | no answer yet |
  | `in-progress` | an answer is waiting for approval |
  | `addressed` | the owner approved an answer |
  | `closed` | the owner added `status: done` (or `closed`) to the request's frontmatter |
- **In the Helix:** a request shows its status and answers. A pending answer can be reviewed and approved right there, and it is gold because it is a proposal. The request itself is never gold.

## Part 3: the live path

This already existed: the bridge (`mnemo-ctl ui` / `hub` / Mnemo.app) serves the Helix live data, and settles approve and reject in view. Owner writes and requests reuse it. The snapshot (`export-graph`) stays read-only.

## QA gate (Vesper)

| Check | Covered by |
|---|---|
| An owner write lands byte for byte, atomically, and the index reflects it without a restart | `packages/mnemo-mcp/test/owner.test.ts` |
| An agent proposal against a note the owner edited settles as stale, and the owner's bytes stay | same |
| A request can be read over MCP, written by no agent tool, and answered through the gate, with the status following | same |
| Read-only mode and person keys: no editor, and writes refused | same |
| Catalina: the editor renders and accepts input on the floor machine | joins the hardware pass list. It is a plain `<textarea>`, with no editor dependency. |

## Agents

- **Cori:** sees `list_requests` and the `request` argument automatically.
- **Vesper:** `custom.mnemo` adds `list_requests` to its Phase-1 allowlist (it now lists 16 tools). See `connectors/custom.mnemo/CONNECTOR.md`.
