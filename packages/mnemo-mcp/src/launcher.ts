import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Vault } from "./vault.js";

/**
 * Launching without Terminal. A running `ui`/`hub` records its local link and process id in
 * .mnemo/ (mode 600; agents can't read .mnemo/ through the vault jail), so `launch` can find it,
 * `stop` can end it, and a double-clicked Mnemo.app can reopen it. The builders below are pure so
 * they can be tested anywhere; only macOS compiles the app.
 */
const URL_FILE = "ui-url";
const PID_FILE = "ui.pid";

/** Quote one argument for /bin/sh. */
export const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** Escape for an AppleScript string literal. */
const asq = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/** AppleScript for Mnemo.app: run the launch command; show its error in a dialog if it fails. */
export function appleScriptSource(shellCommand: string): string {
  return [
    "on run",
    "  try",
    `    do shell script ${asq(shellCommand)}`,
    "  on error errMsg",
    '    display dialog "Mnemo could not start:" & return & return & errMsg buttons {"OK"} default button 1 with title "Mnemo" with icon caution',
    "  end try",
    "end run",
    "",
  ].join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * LaunchAgent that starts Mnemo at login and restarts it if it stops unexpectedly (e.g. the hub
 * started before Tailscale was up). launchd retries no more often than every 15 s.
 */
export function launchAgentPlist(label: string, args: string[], logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export function writeRunState(vault: Vault, url: string, pid: number) {
  const dir = vault.ensureState();
  fs.writeFileSync(path.join(dir, URL_FILE), url, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, PID_FILE), String(pid), { mode: 0o600 });
}

/** Remove the run state, but only if it is still ours (a newer instance may have replaced it). */
export function clearRunState(vault: Vault, pid = process.pid) {
  const dir = vault.stateDir;
  try {
    if (Number(fs.readFileSync(path.join(dir, PID_FILE), "utf8")) !== pid) return;
  } catch {
    return;
  }
  for (const f of [URL_FILE, PID_FILE]) fs.rmSync(path.join(dir, f), { force: true });
}

export function runPid(vault: Vault): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(vault.stateDir, PID_FILE), "utf8"));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The local link of a running ui/hub for this vault, if one answers; null otherwise. */
export function runningUrl(vault: Vault, timeoutMs = 1500): Promise<string | null> {
  let url: string;
  try {
    url = fs.readFileSync(path.join(vault.stateDir, URL_FILE), "utf8").trim();
  } catch {
    return Promise.resolve(null);
  }
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url);
  if (!m) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: Number(m[1]), path: "/", headers: { Host: `127.0.0.1:${m[1]}` }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
