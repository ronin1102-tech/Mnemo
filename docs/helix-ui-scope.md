# Mnemo Helix UI — Scope & Spec

_Drafted 2026-10-23 at Tracy's go, in the Mnemo chat. Status: SCOPED, not commissioned. Companion to `scope-note.md` and `mcp-server-scope.md`. Lanes when commissioned: Alice spec-review → Claude implements → Vesper QA → Tracy gates._

## 1. What this is

The helix is Mnemo's signature view: the emblem (interpretation #1 — the water helix, gold nodes, chosen by Tracy 2026-10-23) rendered as a living interface. The coil rises out of the spring; **every node on the coil is a note**; connections between notes are drawn between nodes. Tracy's formulation: "the mark and the graph are the same object."

It exists in two modes:

- **Emblem mode** — the pure mark. Shown on vault open (the rising transition, §5), on empty states, and as the app's quiet identity surface. No data, just the spring and the coil.
- **Graph mode** — the populated helix: the user's actual vault, laid out on the coil. This is Mnemo's answer to Obsidian's graph view — except where Obsidian's is a force-directed web you look at, Mnemo's is a strand you climb.

**Parity rule (non-negotiable):** the helix is a *view*, never a replacement for the furniture. Sidebar, file tree, tabs, editor, command palette — the Obsidian layout switchers expect — all remain exactly where they expect them. The helix is entered like Obsidian's graph view is entered, and left just as easily. Acceptance comes from the furniture; retention comes from the helix.

## 2. Spatial semantics — what position means

A force graph's positions mean almost nothing (the physics decides). The helix's positions must mean something, or it's decoration. The layout below is Vesper's design proposal for Alice's review and Tracy's ratification.

- **The vertical axis is time.** The spring at the base is the source — the oldest notes sit lowest, nearest the water. The coil rises through time; the newest note is at the growing top. The strand is the vault's life in order, and it is always growing upward. ("Memory rises from the spring.")
- **The two strands are link partners.** A note is placed on the strand opposite its strongest link, so that **wikilinks render as rungs** — the base pairs of the DNA. The most-connected relationship in a note's life becomes its pair across the coil. Placement is computed from the link graph (MCP server index), greedy and stable: adding a note never reshuffles the existing strand (layout stability is a UX requirement — a brain you can't re-find things in is a failed brain).
  **Definition of "strongest link" (ratified 2026-10-23, Re-QA decision 2).** Notes are placed **oldest-first**, and a note considers only link partners that are *older* than itself, since those are the only ones already placed. Among them, the **strongest** partner is the one that shares the most neighbours with the note (each partner scores 1, plus 1 for every other note the two have in common), with ties broken in favour of the **most recent** partner. The note takes the strand opposite that partner. A note with no older partner goes to whichever strand currently holds fewer notes. Because placement depends only on older notes, adding newer notes can never move or re-flip an existing note. The known limit: *backdating* a note (an older `created` than notes already on the coil) re-places the notes that follow it.
- **Time axis (ratified for V1, Re-QA decision 3).** A note's position in time is its frontmatter `created` when present, otherwise its file modified time. Consequence to know about: **a note without `created` moves to the top of the coil each time it is edited**, because editing changes its mtime. Notes with `created` never move on edit. Giving notes a `created` field is how a user pins a note to its place in the vault's history.
- **Rungs = explicit links.** A `[[wikilink]]` between two notes draws a rung (or a short arc when the pair isn't directly opposite). Solid, quiet, blue-white.
- **Arcs = similarity.** `find_similar` relationships (shared links/tags, per the MCP spec §8) draw as arcs bowing outward from the coil. Dashed or faint until focused. Every arc carries its reason ("shares 3 links, 2 tags") — visible on hover/focus, never a bare line.
- **The water is the root.** The rippling pool at the base is the vault itself — clicking it returns to the whole-vault view from any focus.

**Scale handling:** a 10,000-note vault is not drawn at once. The helix shows a **window** — by default the most recent ~300 notes plus their rungs — and travelling (scroll) moves the window along the strand through time. Focus mode (§3) can pull any note and its neighbourhood into the window regardless of age. Windowing parameters are part of the performance budget (§7).

## 3. Focus mode — the local graph, translated

Obsidian's local graph (neighbourhood of the active note, with depth control) is the half of its graph people actually use daily. The helix equivalent:

- Click a node (or invoke "Open in Helix" on any note) → the coil **re-centres**: that note comes to the middle of the window, its rungs and arcs brighten, everything else dims to ghost. Depth control (1–3 hops) matches the parity expectation.
- The focused note shows a card: title, excerpt, tags, backlink count, similarity reasons for its arcs. Enter (or double-click) opens it in the editor. Esc returns to the whole-vault window.
- Search behaves spatially: running a search **lights the matched nodes along the coil** wherever they sit in time, dimming the rest — search results you can *see* in the shape of your own memory. Clicking a lit node focuses it.

## 4. The agent layer, made visible

The helix is where the MCP door becomes something a user can *see* — the differentiator rendered, not hidden in a log.

- **Proposal pulse:** when an agent proposes a write (MCP spec §7), the target note's node **pulses gold** — the emblem's gold, reserved for exactly this. A proposal badge sits on the node; clicking it opens the proposal (full diff) for approve/reject, satisfying the app-approval surface the MCP spec anticipated. Gold means *an agent is asking*. Nothing else in the UI uses gold for decoration.
- **Settled writes:** on approval, the node flashes once and the strand re-renders with the new link structure. On rejection, the pulse dies. No silent changes, ever — the same rule as the server, visible.
- Reads by agents are **not** visualised (noise, and surveilling the user with their own tool is the wrong instinct). Only writes — the gated, consequential acts — appear.

## 5. The rising transition

Tracy's originating idea: opening the vault, the DNA coil rises out of the water.

- Duration ~1.2 s, ease-out, nodes lighting in sequence as the coil climbs. Then it settles into graph mode (or the last view).
- **It is a layer, never a gate:** the editor and sidebar are live underneath from the first frame. A user who starts typing interrupts nothing.
- Skippable (any key/click), plays once per vault open — never on note open, never on refocus. Delight that repeats becomes friction.
- `prefers-reduced-motion` → crossfade only. Below-spec hardware → static emblem fade (§7). The transition is the first thing cut when the performance budget pushes back, and the spec says so out loud.

## 6. Visual language

- Palette is the emblem's: deep navy ground, water-blue strands, blue-white nodes, **gold reserved** for agent proposals and the focused search hit (§4). No other accent colours compete.
- Tag tints (Obsidian colour-group parity): a tag can carry a hue that tints its nodes' halo — subtle, user-assigned, off by default. Colour is information or it is nothing.
- Typography in the helix is minimal: node labels appear on hover/focus and for high-degree nodes at wide zoom. A wall of labels is a failed graph.
- The Greek key / laurel ring from the emblem appears only in emblem mode and branding surfaces — never as chrome around the working graph.

## 7. Performance budgets (the UX budget — fail-able at QA)

UX-first is the product's stated return (scope note, 2026-10-23), and on the target hardware UX *is* performance. These budgets are requirements, not aspirations:

- **Renderer recommendation:** Canvas 2D inside the Tauri webview. WebGL is explicitly *not* required — old-macOS WebGL is the flaky path, and 2D canvas at windowed node counts is well inside budget. (For Alice/Claude to ratify.) The webview in question is Catalina's (the platform floor is macOS 10.15.7, pinned 2026-10-23): all frontend code ships transpiled to that engine — no unpolyfilled modern-only APIs.
- **Frame budget:** rotation/travel animation holds ~60 fps with ≤1,000 nodes on screen on Cori's-Mac-class hardware; degrades gracefully (fewer simultaneous arcs, then reduced node window) rather than dropping frames.
- **Window cap:** default visible window ≈300 nodes, hard cap 1,000 rendered nodes; the rest exist as strand, not as drawn points.
- **Interaction latency:** click-to-focus < 100 ms; search lighting < 200 ms against the server index (same budget family as the MCP spec §10).
- **Fallback:** below the hardware floor, the helix renders as a **static emblem plus the strand list** (§8) — same data, no animation. Nobody on old hardware gets a broken showpiece; they get the dignified version.
- **Size is not a budget** (Tracy's ruling, 2026-10-23): there is no installer-size cap, and no feature is ever traded away for compression. Ordinary hygiene still applies — no gratuitous payloads — but these §7 numbers govern how the helix *runs*, never how many bytes it occupies.

## 8. Accessibility — the strand list

Every helix state has a linear twin: the **strand list** — the same window of notes, in strand (time) order, as a plain keyboard-navigable list with the same focus, rung, and similarity information in text ("linked to X; similar to Y — shares 3 links, 2 tags"). Screen-reader complete; fully usable without ever seeing the coil. This is parity-plus: Obsidian's graph has no equivalent, and Mnemo's audience includes people whose hardware *and* whose needs both argue for the list. The list is not a fallback apology — it's a first-class view sharing the helix's data.

## 9. Data feed — the helix never touches files

The view renders exclusively from the MCP server's surface (server spec §6): `get_neighbors` for focus, `find_similar` for arcs, `search_notes` for lit nodes, `list_recent` for the default window, plus the index's link graph for rungs. If the server can't answer it, the helix doesn't draw it. One source of truth, two surfaces (agents and eyes) reading the same brain the same way — that symmetry is the product's argument in miniature.

## 10. Parity map — Obsidian graph → helix

| Obsidian (mirror map §5) | Helix equivalent |
|---|---|
| Global graph (force layout) | Graph mode, whole-vault window (§2) — order instead of physics |
| Local graph + depth control | Focus mode with 1–3 hop depth (§3) |
| Graph filters | Strand filters: tag, folder, date range narrow the window |
| Colour groups | Tag tints (§6), off by default |
| Physics/display controls | Coil controls: turn density, window size, arc visibility — geometry is meaning, so no physics sliders |
| *(nothing)* | Proposal pulse + in-view approvals (§4); strand list (§8); search made spatial (§3) |

## 11. Versioning — the proposed split (resolves the graph open-call)

- **V1:** emblem mode + the rising transition (§5), graph mode read-only (window, rungs, travel, focus mode, open-in-editor), strand list. The mark, the moment, and the map.
- **V1.1:** similarity arcs with reasons, proposal pulse + in-view approve/reject, strand filters and tag tints.
- Rationale: V1 proves the soul of the thing with the server's simplest data; the agent-visible layer lands with the app-approval surface it depends on. Presented for Tracy's ratification — if he rules the full graph V1, §11 collapses and the budgets in §7 get harder, which the QA gate will price honestly.

## 12. QA gate (Vesper's checks)

- Transition: timing, skip, reduced-motion, never-blocks-input test.
- Layout stability: add notes to the fixture vault; existing node positions must not move.
- Data truth: every rung/arc on screen traced to a server response on the fixture vault (no phantom links).
- Window behaviour at 10,000 notes: caps hold, travel stays smooth, budgets in §7 measured and reported on the oldest available hardware.
- Fallback: forced below-floor mode renders the static emblem + strand list with full function.
- Approval integrity: a proposal approved in the helix produces byte-identical results to the CLI path (same server writer; the view is a surface, not a second gate).

## 13. Open decisions (Tracy's)

1. **Ratify the spatial semantics** (§2): time as the vertical axis; strongest-link pairing as the strands. The whole design hangs on these two.
2. **Ratify the V1/V1.1 split** (§11) — or pull the full graph into V1 at a priced cost.
3. **Gold discipline** (§4/§6): gold reserved for agent proposals only — confirm nothing else earns it.
4. **Renderer ratification** (Alice/Claude, §7): Canvas 2D as recommended.
