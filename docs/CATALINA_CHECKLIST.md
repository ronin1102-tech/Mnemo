# Mnemo V1: Catalina Hardware Pass (Cori's Mac)

**Why:** the platform floor is macOS 10.15.7. Everything so far ran on Linux + Chromium. This pass is the one open blocker for calling V1 done.
**Who:** whoever is at the Mac. **Time:** ~45 min. **Rule:** record every result, pass or fail, in the report at the bottom. Do not fix anything mid-run; a failure is a finding.

Repo: `ronin1102-tech/Mnemo`, branch `claude/new-session-bzyycu`.

## 0. Record the machine (no pass/fail)
```
sw_vers; uname -m; sysctl -n machdep.cpu.brand_string; sysctl -n hw.memsize
diskutil info / | grep -E "File System|Case"      # APFS or HFS+, and whether it is case-sensitive
xcode-select -p; clang --version | head -1
node -v 2>&1; npm -v 2>&1
```
Safari version: Safari > About Safari. **Write it down.** A fully updated Catalina runs Safari 15.6.1, not Safari 13. The app's webview uses whichever WebKit the OS has, so the test is: record the version, then test that. If a second, un-updated Mac or VM with Safari 13 exists, repeat section 6 there too.

## 1. Node and install (the highest-risk step)
`better-sqlite3` is a native module. Node 22+ and 24 do not support Catalina; use **Node 20 LTS** (supports macOS 10.15+). Do not try newer.
```
node -v                       # expect v20.x
git clone https://github.com/ronin1102-tech/Mnemo.git && cd Mnemo
git checkout claude/new-session-bzyycu
npm run install:all           # watch for: prebuilt binary downloaded vs. compiling from source
npm run build
```
| Check | Pass |
|---|---|
| `install:all` finishes with no error | |
| `better-sqlite3`: prebuilt download, or built from source? (note which) | info |
| If it compiled: needed Xcode Command Line Tools (which version)? | info |
| `npm run build` clean | |
**If install fails:** save the full error text. Do not work around it. That text is the finding.

## 2. Automated tests
```
npm test
```
Expect **40 server + 15 UI** passing. Record any failure verbatim. Any failure is likely FS- or OS-specific, which is exactly what this pass is for.

## 3. Budgets on the real hardware
```
npm --prefix packages/mnemo-mcp run bench
```
| Budget | Target | Linux result (reference) | Mac result |
|---|---|---|---|
| Cold index, 10k notes | < 30 s | ~1.3 s | |
| Server start | < 1 s | ~0.2 s | |
| Search p95 | < 200 ms | ~68 ms | |
| Idle RSS | < 128 MB | ~111 MB | |
Report honestly even if it fails; an old Mac running a slower disk is the whole point. Note CPU model and whether the disk is SSD or spinning.

## 4. The server over stdio with a real vault
```
VAULT=$(mktemp -d)
node packages/mnemo-mcp/scripts/make-vault.mjs $VAULT 10000
node packages/mnemo-mcp/dist/ctl.js --vault $VAULT reindex        # note the time
node packages/mnemo-mcp/dist/ctl.js --vault $VAULT export-graph --out packages/helix/dist/graph.js
ls -la packages/helix/dist/graph.js                                # ~size, expect a few MB
```
Connect one real MCP client (Claude Desktop, Claude Code or Cori) with
`{"command":"node","args":["<repo>/packages/mnemo-mcp/dist/cli.js","--vault","<VAULT>","serve"]}`.

| Check | Pass |
|---|---|
| Client connects; lists the 15 tools | |
| `search_notes` "memory helix" returns hits quickly | |
| `read_note` returns frontmatter, outgoing links and backlinks | |
| `write_note` returns a pending proposal and the file on disk is **unchanged** | |
| `mnemo-ctl list`, then `show <id>` prints the diff | |
| `mnemo-ctl approve <id>` lands it; `show <id>` now shows `settled ... by mnemo-ctl (<your username>)` | |
| Same note edited by hand after proposing, then approve: refused as **stale** | |
| `serve --read-only`: client sees no write tools | |

## 5. Mac-specific filesystem checks (APFS/HFS+ are case-insensitive by default)
This is the area Linux testing could not cover. In a small test vault:
| Check | Expect | Pass |
|---|---|---|
| Notes `Note.md` and a proposed `write_note` to `note.md` | Treated as the **same** file (replace), not a duplicate; no data loss | |
| `read_note` with `.MNEMO/x.md` and `.Mnemo/x.md` | Rejected (reserved) | |
| Link `[[note]]` to a note stored as `Note.md` | Resolves | |
| `move_note` changing only the case (`a.md` to `A.md`) | Either works or fails cleanly; **file must not vanish** | |
| Symlink inside the vault pointing outside, then `read_note` on it | Rejected | |
| `mnemo-ctl approve` while the file is open in another app (e.g. TextEdit) | Lands atomically; no `*.mnemo-tmp-*` left behind | |
If any of these loses or duplicates a note, stop and report immediately; it is a data-safety bug.

## 6. Helix UI in the Mac's webview
Open `packages/helix/dist/index.html` in **Safari** (File > Open, or `open -a Safari`). Safari 13 note: if the page is blank, open Develop > Show Web Inspector and copy the console error. That is the finding.

| Check | Pass |
|---|---|
| Page renders; emblem shows ring, coil, pool, gold beads on navy | |
| Click: the coil rises out of the water (~1.2 s), nodes light bottom-up | |
| Press a key mid-rise: skips instantly | |
| Scroll (wheel / trackpad) moves smoothly newest to oldest; bottom shows the pool | |
| Click a node: re-centres, rungs brighten, others dim; Depth 1/2/3 changes the dimming | |
| Arrow keys move between notes; Esc clears focus, Esc again returns to emblem | |
| Click the pool: clears focus, back to newest | |
| Graph button: read-only graph appears; drag pans, wheel zooms | |
| Strand list on the right is keyboard-navigable; VoiceOver (Cmd+F5) reads each row | |
| No gold anywhere except the emblem and proposal markers (demo has one proposal) | |
| System setting Reduce Motion on: no rise, short crossfade only | |
| Text is crisp on a Retina and on a non-Retina display (if both available) | |
| Load time with the 10k-note `graph.js`: page usable in how many seconds? (Linux Chromium reference: ~1.5 s; Graph button ~0.25 s) | |

### Frame rate (the 60 fps claim)
In Safari: Develop > Show Web Inspector > Console. Open the Helix view first (click the canvas), then paste:
```js
(async () => {
  const c = document.getElementById("stage"), gaps = []; let last = performance.now(), dir = 1, n = 0;
  await new Promise((done) => {
    (function tick(t) {
      gaps.push(t - last); last = t;
      if (++n % 90 === 0) dir = -dir;
      c.dispatchEvent(new WheelEvent("wheel", { deltaY: 14 * dir, cancelable: true }));
      n < 400 ? requestAnimationFrame(tick) : done();
    })(last);
  });
  gaps.shift(); gaps.sort((a, b) => a - b);
  console.log({ fps: (1000 / (gaps.reduce((a, b) => a + b) / gaps.length)).toFixed(1), p95_ms: gaps[Math.floor(gaps.length * 0.95)].toFixed(1), worst_ms: gaps[gaps.length - 1].toFixed(1) });
})();
```
Run it with the **10k-note** `graph.js` loaded, and again with the demo data (delete `graph.js`, reload). Target is about 60 fps (p95 under ~20 ms). Linux Chromium reference: 10k notes 59.6 fps, p95 16.8 ms, worst 66.6 ms; demo 60.0 fps, p95 16.7 ms. Record both, and the Mac's display refresh rate. A software-rendered canvas on old hardware is exactly what this is meant to catch.

## Report template (copy back to Vesper / Claude)
```
Mac: model/year, CPU, RAM, disk type | macOS 10.15.x | Safari version | Node version
Section 1 install:  PASS/FAIL  (better-sqlite3: prebuilt|compiled)  error text if any
Section 2 tests:    X server / Y UI passing  failures:
Section 3 bench:    index __s | start __s | search p95 __ms | idle __MB
Section 4 stdio:    PASS/FAIL per row, client used
Section 5 FS:       PASS/FAIL per row, anything lost/duplicated = STOP
Section 6 UI:       PASS/FAIL per row, 10k load __s, fps (10k) __, fps (demo) __, p95 __ms
Console errors (verbatim):
Anything surprising:
```

## Exit criteria
- Sections 1 and 2 pass, or the failure is recorded verbatim.
- Section 5 shows no data loss or duplication.
- Section 6 renders on the Mac's webview, with a measured fps for both vault sizes.
- Every FAIL gets a ship / fix / defer decision from Tracy.
