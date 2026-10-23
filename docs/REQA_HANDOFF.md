# Mnemo V1: Re-QA Handoff (for Vesper)

**Repo:** ronin1102-tech/Mnemo, branch `claude/new-session-bzyycu`, head `78fdbb3`
**Your last run:** `da955fe`. Diff to review: `git diff da955fe..78fdbb3` (4 feature commits, plus a docs commit).
**Reference docs:** `mcp-server-scope.md`, `helix-ui-scope.md`, `docs/CATALINA_CHECKLIST.md` (the real-hardware pass, still unrun).

## Setup
```
npm run install:all && npm run build && npm test    # expect 40 server + 16 UI passing
npm --prefix packages/mnemo-mcp run bench           # 10k-note budgets
node packages/mnemo-mcp/scripts/make-vault.mjs <dir> 10000    # synthetic vault with frontmatter + md links
node packages/mnemo-mcp/dist/ctl.js --vault <dir> export-graph --out packages/helix/dist/graph.js
```

## What changed since your report
**Your findings**
- **F1 frontmatter:** `title`, `created`, `tags` (`[a, b]`, `a, b`, `- a` list) now parsed; tags are in the FTS ranking, `get_tags` and `find_similar`. Frontmatter is never rewritten.
- **F2 strand semantics:** a note sits on the strand opposite its strongest link partner. Placement runs oldest-first and looks only at older notes, so adding newer notes never moves or re-flips existing ones.
- **F4 spring / F5 palette:** palette is the mark's (navy, water blue, blue-white). The spring is the pool at the oldest end; the coil narrows into it; clicking it clears focus. The emblem is drawn as the mark. The rising transition (about 1.2 s, once per page load) is built.
- **F6/F7:** unchanged (snapshot via `graph.js`; no app shell). Accepted per your report.
- **Tracy's follow-ups:** `settledBy` (actor `mnemo-ctl` + OS username) and `resolvedAt` on settled proposals; date filters use frontmatter `created` with mtime fallback; `mnemo-ctl list` kept; re-basing a moved note's own relative links logged as V1.1.

**Spec-conformance fixes beyond your report (found by reading `mcp-server-scope.md`)**
`search_notes` filters (folder, tag, date range); `read_note` returns frontmatter + outgoing + backlinks; `get_backlinks` returns the linking line; `get_neighbors` adds unlinked `related` notes (shared links/tags); `list_notes` returns folder counts; `list_recent` defaults to 20; relative `[text](note.md)` links are graph edges and are rewritten by `move_note`; size cap is 10 MB (over-cap notes are readable, not patchable).

**Found and fixed during checklist validation:** the Helix page took 12.3 s to load at 10k notes (eager O(n^2) graph layout). Now lazy, and a time-ordered spiral above 2,000 notes. Load is about 1.5 s; Graph mode opens in about 0.25 s.

**Helix additions:** focus depth 1-3 with a card (excerpt, tags, backlink count); 1,000-node render cap; the time axis uses `created` when present.

## What to re-verify (regression + new claims)
1. **Your 11 original claims still hold** (jail, write gate, patch fail-closed, move rewrite, stale halt, atomic writes, expiry, delete-to-trash, read-only, gold, index freshness). The index schema and link model changed underneath them (schema v4, link kinds), so re-run your attack harness in full.
2. **F1 edge cases** (my parser is a deliberate YAML subset, so break it): CRLF files; `---` inside the body; empty `tags:`; tags with quotes, `#`, uppercase, spaces; multi-line or folded titles; colons in titles; BOM at file start; frontmatter-only notes; a `tags:` line indented under another key; `created` as a date, datetime, number, or garbage. Confirm `get_tags` and `find_similar` against a hand-checked fixture. **Re-run the similarity ranking QA you deferred until F1.**
3. **Move with markdown links:** relative links from nested folders, `./` and `../`, `%20`-encoded paths, `<angle brackets>`, link titles (`[x](a.md "t")`), fragments, links inside code fences (these are rewritten too: is that acceptable?), reference-style links (not handled), and case differences. Confirm a rewrite never changes an unrelated link and never changes frontmatter semantics.
4. **Stability claim (helix spec section 12):** add newer notes to a fixture and confirm no existing node's strand or distance-from-spring changes (a unit test covers it; check in the real UI with a 2-pass export). Known limit: backdating a note into the middle (older `created`) re-places later notes.
5. **Data truth (section 12):** every rung on screen traces to a server link; no phantom links. Compare `graph.js` links to `get_neighbors` / `get_backlinks` on a fixture.
6. **Rising transition (section 12):** timing about 1.2 s, any key or click skips, reduced-motion gives a crossfade only, never blocks input, plays once per load.
7. **`settledBy`:** present on approved, rejected, stale (halted) and expired proposals; absent while pending; `mnemo-ctl show` prints it; `list_proposals` over MCP exposes it.
8. **Date filters:** `created` precedence with mtime fallback, `before`/`after` boundaries (date-only `before` is inclusive of the whole day).
9. **Index migration:** open a vault indexed by the old build (schema v2/v3). The index should drop and rebuild silently with identical results. Also run `mnemo-ctl reindex` while a server is live.
10. **Budgets:** re-run at 10k notes. Reference (Linux): cold index about 1.3 s, start about 0.2 s, search p95 about 68 ms, idle about 111 MB (budget 128 MB). Frontmatter and link parsing added indexing work, so watch cold-index time.
11. **Gold discipline:** see decision 1 below. Verify gold appears only on proposal markers and the proposal badge in the working UI, and only the mark's own gold in the emblem.

## Decisions I need from you / Tracy (please give an opinion)
1. **Emblem gold:** the mark's gold ring and beads are drawn in emblem mode (isolated in code as `markGold`, enforced by test). The brief says gold is proposals-only. Is the mark itself exempt? The helix spec section 4/6 also assigns gold to the focused search hit; V1 has no spatial search, so I left that out.
2. **Strand pairing heuristic:** "strongest link" = most shared neighbours, then most recent. The spec does not define "strongest". Is that a defensible reading?
3. **Time axis:** `created` first, else mtime. Editing an old note with no `created` moves it to the top. Acceptable for V1?

## Known open items (not hidden; confirm severity)
- **Catalina / Safari 13 / ThinkCentre untested.** Still the single blocker for "V1 done". Checklist is ready.
- **Not built:** open-in-editor (no editor), spatial search lighting, below-floor static fallback, similarity text in the strand list (V1.1 arcs), window default of about 300 notes (the whole strand is drawn with culling and a 1,000-node cap).
- **Graph mode on large vaults** (over 2,000 notes) uses a deterministic spiral, not a force layout.
- **Multi-file move is not crash-atomic** (as you verified); journal/resume is V1.1.
- **`mnemo-ctl` is a convention, not a sandbox.**
- **Idle memory** budget raised to 128 MB by decision (Node + MCP SDK floor is about 76 MB).
- **Housekeeping:** no proposal pruning; trash filename collision within one millisecond is theoretically possible.

## Exit criteria
All 11 original claims plus the new claims above hold; budgets reproduce; F1-F5 closed or re-opened with evidence; decisions 1-3 answered; Catalina pass scheduled.
