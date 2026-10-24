import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { appleScriptSource, launchAgentPlist, runningUrl, shq, writeRunState, clearRunState } from "../src/launcher.js";
import { Vault } from "../src/vault.js";
import { describe, expect, it } from "./expect.js";
import { tmpVault } from "./helpers.js";

const ctl = path.resolve("dist", "ctl.js"); // npm test builds dist first

function uiDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ui-"));
  for (const f of ["index.html", "app.js", "style.css"]) fs.writeFileSync(path.join(d, f), "x");
  return d;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const run = (args: string[]) => spawnSync(process.execPath, [ctl, ...args], { encoding: "utf8", timeout: 30000 });

describe("launcher building blocks", () => {
  it("shell quoting survives spaces, quotes and $ in paths (checked by a real sh)", () => {
    for (const s of ["/Users/x/My Notes", "it's", 'say "hi"', "$HOME `x` \\n", "ünïcode/folder"]) {
      const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${shq(s)}`], { encoding: "utf8" });
      expect(echoed).toBe(s);
    }
  });
  it("the app's AppleScript escapes the command and reports failures in a dialog", () => {
    const src = appleScriptSource(`'/usr/local/bin/node' 'a "b"' 'c\\d'`);
    expect(src).toContain(`do shell script "'/usr/local/bin/node' 'a \\"b\\"' 'c\\\\d'"`);
    expect(src).toContain("display dialog");
  });
  it("the login agent escapes XML and restarts only after failures", () => {
    const x = launchAgentPlist("com.mnemo.hub", ["/node", "/a&b/<c>"], "/log");
    expect(x).toContain("<string>/a&amp;b/&lt;c&gt;</string>");
    expect(x).toContain("<key>SuccessfulExit</key><false/>");
    expect(x).toContain("<key>RunAtLoad</key><true/>");
  });
  it("run state is private and only cleared by its owner", () => {
    const vault = new Vault(tmpVault({}));
    writeRunState(vault, "http://127.0.0.1:1/#token=x", 4242);
    if (process.platform !== "win32") expect(fs.statSync(path.join(vault.stateDir, "ui-url")).mode & 0o077).toBe(0);
    clearRunState(vault, 999); // someone else's: left alone
    expect(fs.existsSync(path.join(vault.stateDir, "ui-url"))).toBe(true);
    clearRunState(vault, 4242);
    expect(fs.existsSync(path.join(vault.stateDir, "ui-url"))).toBe(false);
  });
});

describe("launch and stop (real processes)", () => {
  it("launch starts Mnemo in the background, a second launch finds it, stop ends it", async () => {
    const root = tmpVault({ "a.md": "# A" });
    const port = await freePort();
    const ui = uiDir();
    const first = run(["--vault", root, "launch", "--no-open", "--port", String(port), "--ui", ui]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Mnemo is running (ui)");
    const vault = new Vault(root);
    const url = await runningUrl(vault);
    expect(url ?? "").toContain(`http://127.0.0.1:${port}/#token=`);

    const second = run(["--vault", root, "launch", "--no-open", "--port", String(port), "--ui", ui]);
    expect(second.stdout).toContain("already running");

    const stop = run(["--vault", root, "stop"]);
    expect(stop.stdout).toContain("Mnemo stopped");
    expect(await runningUrl(vault)).toBe(null);
    expect(fs.existsSync(path.join(vault.stateDir, "ui.pid"))).toBe(false);
    expect(run(["--vault", root, "stop"]).stdout).toContain("isn't running");
  }, 60000);

  it("a launch that can't start says why instead of hanging", async () => {
    const root = tmpVault({});
    const port = await freePort();
    const r = run(["--vault", root, "launch", "--no-open", "--port", String(port), "--ui", path.join(os.tmpdir(), "no-such-ui-dir-mnemo")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Mnemo didn't start");
    expect(r.stderr).toContain("UI not built");
  }, 60000);

  it("launcher is macOS-only and says what to use instead", () => {
    if (process.platform === "darwin") return;
    const r = run(["--vault", tmpVault({}), "launcher"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mnemo-ctl --vault <dir> launch");
  });
});
