# Mnemo: Install and Test Notes

For running Mnemo yourself, on macOS 10.15 (Catalina) or newer, Windows, or Linux.
Time: about 20 minutes. Branch: `main`.

> **Use Node 20. Nothing newer.** Everything in this repo is pinned to run on Node 20 LTS, the last line that supports macOS 10.15. The whole sequence below was run start to finish from a clean clone on Node 20.20.2 (Linux).

> **Test on a copy of your notes,** never your only vault. Mnemo never writes a note without your approval, but it does create a `.mnemo/` folder inside the vault (index, proposals, logs).

## 1. Install Node 20

| System | How |
|---|---|
| macOS (incl. Catalina) | Download the **Node 20 LTS** macOS installer (`.pkg`) from nodejs.org (Downloads > Previous releases > v20.x), run it. |
| Windows | Node 20 LTS Windows installer (`.msi`) from nodejs.org. |
| Linux | Your package manager's Node 20, or the nodejs.org binary. |
| Already use nvm | `nvm install 20 && nvm use 20` (the repo has an `.nvmrc`). |

Check (open Terminal; on Windows, PowerShell):
```
node --version     # must start with v20.
npm --version
```

## 2. Get the code
> **Use a fresh download.** Copies of `main` taken before 2026-10-23 (before PR #1 was merged) will not install on Catalina. If you have an older folder, delete it and start again from this step.

Either **git**:
```
git clone https://github.com/ronin1102-tech/Mnemo.git
cd Mnemo
```
On Catalina, the first `git` use may ask to install Apple's command-line tools: accept, or skip git entirely: download
`https://github.com/ronin1102-tech/Mnemo/archive/refs/heads/main.zip`
(or on GitHub: **Code > Download ZIP**). It unzips to a folder named `Mnemo-main`; `cd` into it.

## 3. Install, build, test
From the `Mnemo` folder:
```
npm run install:all
npm run build
npm test
```
Expect:
- install: two "added N packages" lines, **no `EBADENGINE` warnings**, no `ERR`. It downloads a ready-made SQLite binary for your system; nothing is compiled.
- build: `built dist/`
- test: two summaries from Node's built-in test runner, `ℹ pass 59` / `ℹ fail 0` (server) and `ℹ pass 27` / `ℹ fail 0` (UI).

Every native program this installs on a Mac has been checked to run on macOS 10.15: esbuild 0.23.1 (needs 10.13+) and better-sqlite3 12.9.0 (10.7+). A test fails the build if an upgrade ever brings back one that needs macOS 11+.

## 4. See the Helix UI (demo data)
Open `packages/helix/dist/index.html` in your browser:
- macOS: `open -a Safari packages/helix/dist/index.html`
- Windows: `start packages\helix\dist\index.html`
- Linux: `xdg-open packages/helix/dist/index.html`

You'll see the emblem. Click it: the coil rises from the water. Scroll to travel through time; click a note to focus it; Esc to step back; try **Graph**. The header's **Effects** button shows which effects tier your machine settled on.

## 5. Load real notes (a copy)
```
node packages/mnemo-mcp/dist/ctl.js --vault "/path/to/vault-copy" reindex
node packages/mnemo-mcp/dist/ctl.js --vault "/path/to/vault-copy" export-graph --out packages/helix/dist/graph.js
```
Reload the page. The header now says `Vault · N notes`. Re-run `export-graph` whenever you want the view refreshed (the UI is a snapshot in V1).
No notes handy? Make a synthetic vault: `node packages/mnemo-mcp/scripts/make-vault.mjs ./sample-vault 500`.

## 6. (Optional) Connect an AI agent and try the write gate
Add Mnemo to an MCP client. Use **absolute paths**, including to `node` itself (desktop apps often don't see your shell's PATH; `which node` on macOS/Linux, `where node` on Windows, tells you the path).

```json
{
  "mcpServers": {
    "mnemo": {
      "command": "/usr/local/bin/node",
      "args": ["/full/path/to/Mnemo/packages/mnemo-mcp/dist/cli.js", "--vault", "/full/path/to/vault-copy", "serve"]
    }
  }
}
```
Claude Desktop's config file: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`. Restart the app after editing. (Check that your MCP client itself supports your OS version.) Add `"--read-only"` before `"serve"` for look-but-don't-touch.

Then:
1. Ask the agent to search your notes and to append a line to one. It will say it made a **proposal**; the note on disk is unchanged.
2. Re-export the graph (step 5) and reload the page: that note now carries a **gold ring**, the only gold in the working view, meaning "an agent is asking".
3. Review and decide, as the human:
   ```
   node packages/mnemo-mcp/dist/ctl.js --vault "/path/to/vault-copy" list
   node packages/mnemo-mcp/dist/ctl.js --vault "/path/to/vault-copy" show <id>
   node packages/mnemo-mcp/dist/ctl.js --vault "/path/to/vault-copy" approve <id>     # or reject <id>
   ```
   After approving, open the note: the change is there, byte for byte what `show` printed.

## 7. If something goes wrong
| Symptom | What to do |
|---|---|
| `node --version` isn't v20 | Install Node 20 (step 1); with nvm, `nvm use 20`. |
| `EBADENGINE` / "Unsupported engine" warnings mentioning vitest 5 or better-sqlite3 13 | You have an old copy (from before PR #1). Delete it and download `main` again (step 2) into a fresh folder. |
| `dyld: Symbol not found` ... "built for Mac OS X 12.0" (esbuild) | Same cause: an old copy. Current `main` pins tools that run on 10.15. |
| `npm ERR! engine` with a different package | Note it in your report; check `node --version` is v20. |
| Install prints `gyp`, `make` or "compiling" lines, or fails in `better-sqlite3` | The ready-made binary couldn't download (network or unusual CPU), so it tried to compile. On macOS run `xcode-select --install`, then `npm run install:all` again. Copy the full error into your report either way. |
| Page is blank | Safari: Develop > Show Web Inspector > Console (enable the Develop menu in Safari > Preferences > Advanced). Copy the red errors. |
| Header still says "Demo vault" after exporting | Check `packages/helix/dist/graph.js` exists (the `--out` path), then reload the page. |
| Agent doesn't see Mnemo | Absolute paths for `node`, `cli.js` and the vault; restart the client. |
| Laggy | Watch the Effects tier; click **Effects** to turn effects off, and note your Mac model in the report. |
| `npm --prefix packages/mnemo-mcp run bench` fails on Windows | Expected: the benchmark measures memory with `ps` (macOS/Linux only). |

## 8. What to send back
```
Machine: model/year, OS + version, browser + version, node --version
Step 3: install OK? (prebuilt or compiled)  tests: pass __ / 59 server, pass __ / 27 UI
Step 4: renders? Effects tier it settled on: ____  smooth / laggy
Step 5: vault size __ notes; export OK? looks right?
Step 6 (if done): client used; proposal created; approve landed; gold ring seen?
Errors (copied verbatim), screenshots of anything odd
```
