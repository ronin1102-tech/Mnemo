# Mnemo: Re-QA Handoff #3, Premium UI + Node 20 (for Vesper)

**Repo:** ronin1102-tech/Mnemo, branch `claude/new-session-bzyycu`. Code under review: `1a7de2b` and the docs commit after it.
**Your last pass:** `78fdbb3` (PASS). Diff: `git diff 78fdbb3..HEAD`. Three blocks of change: the V1.1 patch list you raised (`129abd5`), the premium UI revamp (`9e1a594`, `cb7b6ac`), and the Node 20 toolchain (`1a7de2b`).
**Setup:** follow `docs/INSTALL.md` exactly, on **Node 20** (it is also a test of those notes). Expect `ℹ pass 59` (server) and `ℹ pass 27` (UI).

## 1. Your V1.1 patch list: confirm closed
- **F6** oversized requests: stdio buffer 64 MiB, schema length caps; a 10 MB+ note is refused with an error result and the server stays up. Test drives the real binary over stdio.
- **F7** links inside fenced or inline code are text: not edges, never rewritten by `move_note`.
- **F8** case-variant markdown links are rewritten on move.
- **F1 residuals:** BOM no longer hides frontmatter; folded and literal block-scalar titles.
- **Found on the way:** `lineDiff` was O(n*m) in memory (an agent could exhaust the server with a big rewrite); now bounded. Stored and returned diffs are capped (20,000 / 200 lines); approval still applies the full stored content.

## 2. Node 20 toolchain (new; please attack)
`better-sqlite3` 13 and vitest 5 required Node 22+, which Catalina can't run. Now:
- `better-sqlite3` pinned to exactly **12.9.0**: the newest release that ships prebuilt Node 20 binaries (12.10+ has none for Node 20, forcing a compile). Its macOS x64 binary declares minimum macOS 10.7.
- **Catalina binary audit (after Tracy's first real install failed):** esbuild 0.28's macOS binary is built for macOS 12 (`dyld: Symbol not found: _SecTrustCopyCertificateChain`), and TypeScript 7 ships a native `tsc` also built for 12. Every Mach-O in the tree was measured: esbuild <= 0.23 targets 10.13, 0.24+ targets 11. Now: esbuild pinned 0.23.1 (helix build only), TypeScript 5.9 (plain JS), and **vitest removed**: tests run on Node's built-in `node --test` through a small `expect` adapter (`test/expect.ts`, self-tested to fail on wrong values), which also removes vite/rollup/fsevents/tinypool. Only two native binaries now reach a Mac: esbuild (10.13+) and better-sqlite3 (10.7+). `test/toolchain.test.ts` fails the build if a lockfile reintroduces esbuild 0.24+, native TypeScript, the vite stack, a different better-sqlite3, or any package whose engines exclude Node 20 (verified to trip by faking esbuild 0.28).
- npm audit: server **0 vulnerabilities**; helix 1 moderate (esbuild <= 0.24.2 dev-server CORS advisory, applies only to `esbuild --serve`, which is never used; the build API is unaffected; newer esbuild cannot run on Catalina). Production dependencies: 0 in both.
- `@types/node` 20; `engines >=20`; `.nvmrc`.
- Verified on Node 20.20.2 from a clean clone: install (prebuilt, no compile, no EBADENGINE), build, all tests, bench.
**Check:** install on Node 20 prints no `gyp` lines and no `EBADENGINE`; nothing in the tree requires Node 22 or macOS 11+; on a real Catalina Mac, `node_modules/esbuild/bin/esbuild --version` runs.

## 3. Premium UI: claims to verify
1. **Gold discipline (strict):** proposal gold only inside `proposedMarker` (render.ts); the mark's gold only in `emblem.ts`; none in CSS outside `.proposal` selectors or in the HTML. Enforced by `test/colors.test.ts`; please also check visually that no particle, glow, or chrome is gold except proposal markers and the emblem.
2. **No Safari-13-hostile APIs:** no `shadowBlur`, `ctx.filter`, WebGL, `OffscreenCanvas`, flex `gap`, `inset`, `:focus-visible`; `backdrop-filter` has the `-webkit-` prefix; bundle is ES2019. Grep it.
3. **Quality governor:** judges by frame interval (canvas raster cost is deferred, so draw-call time under-reports), steps High > Medium > Low > Static, never retries a tier that failed twice, 2 s warm-up hold after load/mode change/tab return, idle 45 s drops to ~30 fps. Reference (Chromium, CPU throttled): 1x settles High at 60 fps, 4x Low at ~51 fps, 8x Static. Reproduce with DevTools CPU throttling; pin tiers with `?fx=0..3`.
4. **Static paths:** `prefers-reduced-motion` gives no animation loop at all (button reads "Reduced motion", disabled); Effects Off persists across reloads (localStorage, wrapped so private mode can't break it).
5. **Particles are analytic:** no per-frame allocation or simulation state (positions are pure functions of time). Check memory stays flat over a few minutes of idle animation.
6. **Accessibility:** strand list is still the complete keyboard / screen-reader twin; focus card has a labelled close button and Esc; depth control is a labelled group; tooltip is decorative (pointer only), never the only source of information.
7. **Layout stability and data truth (helix spec section 12):** unchanged code paths, but re-check: no rung without a server link; adding newer notes moves nothing.
8. **Focus card never covers the coil** on wide screens: the coil glides right while the card is open (over 900 px wide).
9. **Large vaults:** at 10k notes, graph mode no longer whites out (glow scales with on-screen density; focused neighbourhood drawn on top). Page load about 1.5 s for 10k notes.
10. **Phone width (390 px):** no horizontal scroll; Effects collapses to an icon with a full aria-label.

## 4. Fixed during the revamp (regression-check these)
- `[data-mode]` selector also matched `<body data-mode>`: the mode indicator measured the page width, and every click anywhere re-ran the mode switch.
- Governor never stepped down (measured draw-call time only).
- 10k-note graph mode white-out.

## 5. Known risks / not done (confirm severity)
- **Unverified on real Safari 13 / Catalina.** Everything above was checked in Chromium. `globalCompositeOperation = "lighter"` and `-webkit-backdrop-filter` over an animating canvas are the two most likely to cost more in WebKit. The Catalina checklist now records the tier the governor settles on.
- **760-900 px wide windows:** the coil does not shift for the card there, so the card can overlap the left side of the coil.
- **10k-row strand list** is plain DOM (10,000 buttons), not virtualized. Fine in Chromium; watch it on old WebKit.
- Hover tooltip is pointer-only by design (keyboard users get the focus card).
- Still not built (V1.1 per spec): proposal pulse + in-view approval, similarity arcs, strand filters, tag tints, spatial search lighting.

## Exit criteria
Section 1 closed; section 2 reproduced on Node 20 from `docs/INSTALL.md` alone; section 3 claims hold or are reopened with evidence; section 5 risks given a ship / fix / defer call; Catalina pass still scheduled.
