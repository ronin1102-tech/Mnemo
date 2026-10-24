#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAllowedBind, startBridge } from "./bridge.js";
import { TokenStore } from "./tokens.js";
import { appleScriptSource, clearRunState, launchAgentPlist, runPid, runningUrl, shq, writeRunState } from "./launcher.js";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { graphPayload } from "./graph.js";
import { Index } from "./indexer.js";
import { ProposalStore, type ProposalStatus } from "./proposals.js";
import { Vault, VaultError } from "./vault.js";

const USAGE = `mnemo-ctl [--vault <dir>] [--read-only] <command>      (human-only; never exposed over MCP)

  list [status]            List proposals (pending|approved|rejected|expired|stale)
  show <id>                Show a proposal with its diff
  approve <id>             Apply a proposal to the vault (halts if the vault changed since)
  reject <id>              Discard a proposal
  reindex                  Rebuild the search index from the markdown files
  purge-trash              Permanently delete .mnemo/trash
  export-graph [--out f.js]  Write graph data for the Helix UI (default: JSON on stdout)
  ui [--port 7337] [--no-open]  Serve the live Helix UI on 127.0.0.1 and open it: live data,
                           gold proposal pulse, approve/reject in view (same writer as approve)
  hub [--bind <tailscale ip>] [--allow-host <magicdns name>] [--port 7337] [--no-open]
                           The shared vault for your tailnet: the Helix for people and MCP over
                           HTTP (/mcp) for agents. Listens only on 127.0.0.1 and Tailscale addresses.
  launch [--hub ...]       Start Mnemo in the background (if it isn't running) and open it
  stop                     Stop the background Mnemo for this vault
  launcher [--hub ...] [--at-login] [--app <path>]   macOS: create Mnemo.app (double-click to
                           open Mnemo; no Terminal). --at-login also starts it when you log in.
                           launcher --remove takes both away.
  token add <name> --agent|--person [--read-only]   Issue a key for one machine or person
  token list | token revoke <name>

--read-only refuses approve, reject and purge-trash (and removes them from the UI); with token add, issues a read-only key.
`;

/** Open a URL in the default browser (macOS, Windows, Linux). */
function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed; the user can open it */
  }
}

function main(argv: string[]) {
  let vaultDir = process.env.MNEMO_VAULT;
  let readOnly = process.env.MNEMO_READ_ONLY === "1";
  let outFile: string | undefined;
  let port = 7337;
  let noOpen = false;
  let uiOverride: string | undefined;
  const bind: string[] = [];
  const allowHosts: string[] = [];
  let kind: "agent" | "person" | undefined;
  let hubMode = false;
  let atLogin = false;
  let remove = false;
  let appPath: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") vaultDir = argv[++i];
    else if (argv[i] === "--read-only") readOnly = true;
    else if (argv[i] === "--out") outFile = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--no-open") noOpen = true;
    else if (argv[i] === "--ui") uiOverride = argv[++i];
    else if (argv[i] === "--bind") bind.push(argv[++i]);
    else if (argv[i] === "--allow-host") allowHosts.push(argv[++i]);
    else if (argv[i] === "--agent") kind = "agent";
    else if (argv[i] === "--person") kind = "person";
    else if (argv[i] === "--hub") hubMode = true;
    else if (argv[i] === "--at-login") atLogin = true;
    else if (argv[i] === "--remove") remove = true;
    else if (argv[i] === "--app") appPath = argv[++i];
    else args.push(argv[i]);
  }
  const [cmd, arg, arg2] = args;
  if (!cmd || cmd === "help") return void process.stderr.write(USAGE);
  if (!vaultDir) throw new VaultError("No vault: pass --vault <dir> or set MNEMO_VAULT");
  const mutating = ["approve", "reject", "purge-trash"].includes(cmd); // for `token add`, --read-only means "issue a read-only key"
  if (mutating && readOnly) throw new VaultError(`Refusing ${cmd}: read-only mode`);
  const vault = new Vault(path.resolve(vaultDir));
  const store = new ProposalStore(vault);
  const out = (s: string) => process.stdout.write(s + "\n");
  const id = () => {
    if (!arg) throw new VaultError(`${cmd} needs a proposal id`);
    return arg;
  };

  switch (cmd) {
    case "list":
      for (const p of store.list(arg as ProposalStatus | undefined))
        out(`${p.id}  ${p.status.padEnd(8)}  ${p.op.padEnd(6)}  ${p.path}${p.to ? " -> " + p.to : ""}  (${p.client}, expires ${p.expiresAt})`);
      return;
    case "show": {
      const p = store.get(id());
      return out(`${p.id} ${p.status} ${p.op} ${p.path}${p.to ? " -> " + p.to : ""}\nclient: ${p.client}\nproposed by: ${p.client} at ${p.createdAt}\nexpires: ${p.expiresAt}\n${p.settledBy ? `settled: ${p.status} by ${p.settledBy.actor}${p.settledBy.user ? " (" + p.settledBy.user + ")" : ""} at ${p.resolvedAt}\n` : ""}touches: ${p.changes.map((c) => c.path).join(", ")}\n\n${p.diff}`);
    }
    case "approve":
      return out(`approved ${store.approve(id()).op} ${store.get(id()).path}`);
    case "reject":
      return out(`rejected ${store.reject(id()).path}`);
    case "reindex": {
      const index = new Index(vault);
      const r = index.reindex();
      index.close();
      return out(`indexed ${r.notes} notes in ${r.ms}ms`);
    }
    case "purge-trash":
      return out(`purged ${store.purgeTrash()} file(s)`);
    case "export-graph": {
      const index = new Index(vault);
      index.sync();
      const json = JSON.stringify(graphPayload(vault, index, store));
      index.close();
      if (outFile) fs.writeFileSync(outFile, `window.__MNEMO_GRAPH__ = ${json};\n`);
      else out(json);
      return;
    }
    case "ui":
    case "hub": {
      const hub = cmd === "hub";
      const uiDir = uiOverride ? path.resolve(uiOverride) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "helix", "dist");
      if (!fs.existsSync(path.join(uiDir, "index.html"))) throw new VaultError(`Helix UI not built in ${uiDir}: run \`npm run build\` first`);
      if (!hub && (bind.length || allowHosts.length)) throw new VaultError("--bind and --allow-host are for `hub`; `ui` stays on this computer only");
      for (const a of bind) if (!isAllowedBind(a)) throw new VaultError(`Refusing to listen on ${a}: only 127.0.0.1 and Tailscale addresses (100.x / fd7a:115c:a1e0::) are allowed`);
      startBridge(vault, { port, uiDir, readOnly, mcp: hub, bind, allowHosts })
        .then((b) => {
          const names = [...bind.map((a) => (a.includes(":") ? `[${a}]` : a)), ...allowHosts];
          const lines = [
            `mnemo: ${hub ? "hub" : "Helix UI"} for ${vault.root}${readOnly ? " (read-only)" : ""}`,
            `  This computer:  ${b.url}`,
            `                  (the link holds this session's key: don't share it)`,
          ];
          if (hub) {
            lines.push(`  Agents (MCP):   http://127.0.0.1:${b.port}/mcp` + names.map((n) => `\n                  http://${n}:${b.port}/mcp`).join(""));
            lines.push(`                  header  Authorization: Bearer <agent key>   (mnemo-ctl token add <name> --agent)`);
            if (names.length) lines.push(`  People (Helix): http://${names[names.length - 1]}:${b.port}/#token=<person key>   (mnemo-ctl token add <name> --person)`);
            else lines.push(`  Only this computer can connect. For other tailnet machines add --bind <this Mac's Tailscale IP> [--allow-host <its MagicDNS name>].`);
            const keys = new TokenStore(vault).list();
            lines.push(`  Keys: ${keys.length ? keys.map((k) => `${k.name} (${k.kind}${k.readOnly ? ", read-only" : ""})`).join(", ") : "none yet"}`);
          } else lines.push("  Local only (127.0.0.1).");
          lines.push("  Ctrl+C to stop (or: mnemo-ctl stop).");
          process.stderr.write(lines.join("\n") + "\n");
          // let `launch`, `stop` and Mnemo.app find this instance; tidy up on the way out
          writeRunState(vault, b.url, process.pid);
          const done = () => {
            clearRunState(vault);
            process.exit(0);
          };
          process.on("SIGINT", done);
          process.on("SIGTERM", done);
          process.on("exit", () => clearRunState(vault));
          if (!noOpen) openBrowser(b.url);
        })
        .catch((e) => {
          process.stderr.write(`mnemo-ctl: ${e && e.code === "EADDRINUSE" ? `port ${port} is in use; try --port <n>` : e && e.code === "EADDRNOTAVAIL" ? `this computer doesn't have that address (is Tailscale connected?): ${e.address}` : e instanceof Error ? e.message : e}\n`);
          process.exitCode = 1;
        });
      return;
    }
    case "launch": {
      // Start ui (or --hub) in the background if it isn't running, then open the page.
      const mode = hubMode ? "hub" : "ui";
      const ctlPath = fileURLToPath(import.meta.url);
      const childArgs = [ctlPath, "--vault", vault.root, mode, "--no-open", "--port", String(port)];
      for (const a of bind) childArgs.push("--bind", a);
      for (const h of allowHosts) childArgs.push("--allow-host", h);
      if (readOnly) childArgs.push("--read-only");
      if (uiOverride) childArgs.push("--ui", path.resolve(uiOverride));
      (async () => {
        const existing = await runningUrl(vault);
        if (existing) {
          out("Mnemo is already running; opening it.");
          if (!noOpen) openBrowser(existing);
          return;
        }
        const logFile = path.join(vault.ensureState("logs"), "launcher.log");
        const fd = fs.openSync(logFile, "a");
        fs.writeSync(fd, `\n--- ${new Date().toISOString()} launch ${mode}\n`);
        const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", fd, fd] });
        let exited: number | null = null;
        child.on("exit", (c) => (exited = c ?? 1));
        child.unref();
        for (let waited = 0; waited < 20000; waited += 250) {
          await new Promise((r) => setTimeout(r, 250));
          const url = await runningUrl(vault, 500);
          if (url) {
            out(`Mnemo is running (${mode}). Stop it with: mnemo-ctl --vault ${shq(vault.root)} stop`);
            if (!noOpen) openBrowser(url);
            return;
          }
          if (exited !== null) break;
        }
        const tail = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-3).join("\n");
        throw new VaultError(`Mnemo didn't start.\n${tail.replace(/^mnemo-ctl: /gm, "")}\n(full log: ${logFile})`);
      })().catch((e) => {
        process.stderr.write(`mnemo-ctl: ${e instanceof Error ? e.message : e}\n`);
        process.exitCode = 1;
      });
      return;
    }
    case "stop": {
      (async () => {
        const pid = runPid(vault);
        if (!pid || !(await runningUrl(vault))) {
          clearRunState(vault, pid ?? process.pid);
          return out("Mnemo isn't running for this vault.");
        }
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        for (let i = 0; i < 40 && (await runningUrl(vault, 300)); i++) await new Promise((r) => setTimeout(r, 125));
        clearRunState(vault, pid);
        out("Mnemo stopped.");
      })().catch((e) => {
        process.stderr.write(`mnemo-ctl: ${e instanceof Error ? e.message : e}\n`);
        process.exitCode = 1;
      });
      return;
    }
    case "launcher": {
      if (process.platform !== "darwin") throw new VaultError("The Mnemo app launcher is for macOS. Elsewhere, use: mnemo-ctl --vault <dir> launch");
      const app = path.resolve(appPath || path.join(os.homedir(), "Applications", "Mnemo.app"));
      const label = "com.mnemo.hub";
      const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
      if (remove) {
        try {
          execFileSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
        } catch {
          /* wasn't loaded */
        }
        fs.rmSync(plist, { force: true });
        fs.rmSync(app, { recursive: true, force: true });
        return out(`Removed ${app}${fs.existsSync(plist) ? "" : " and the start-at-login entry"}.`);
      }
      const ctlPath = fileURLToPath(import.meta.url);
      const flags: string[] = [];
      if (hubMode) flags.push("--hub");
      if (port !== 7337) flags.push("--port", String(port));
      for (const a of bind) flags.push("--bind", a);
      for (const h of allowHosts) flags.push("--allow-host", h);
      if (readOnly) flags.push("--read-only");
      for (const a of bind) if (!isAllowedBind(a)) throw new VaultError(`Refusing ${a}: only 127.0.0.1 and Tailscale addresses are allowed`);
      // absolute paths throughout: apps opened from Finder don't see Terminal's PATH
      const shell = [process.execPath, ctlPath, "--vault", vault.root, "launch", ...flags].map(shq).join(" ");
      fs.mkdirSync(path.dirname(app), { recursive: true });
      const src = path.join(os.tmpdir(), `mnemo-launcher-${process.pid}.applescript`);
      fs.writeFileSync(src, appleScriptSource(shell));
      try {
        fs.rmSync(app, { recursive: true, force: true });
        execFileSync("osacompile", ["-o", app, src]);
      } finally {
        fs.rmSync(src, { force: true });
      }
      out(`Created ${app}: double-click it to open Mnemo (${hubMode ? "office hub" : "this Mac only"}). Drag it to your Dock if you like.`);
      if (atLogin) {
        const mode = hubMode ? "hub" : "ui";
        const args = [process.execPath, ctlPath, "--vault", vault.root, mode, "--no-open", ...flags.filter((f) => f !== "--hub")];
        const log = path.join(vault.ensureState("logs"), "login.log");
        fs.mkdirSync(path.dirname(plist), { recursive: true });
        try {
          execFileSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
        } catch {
          /* first install */
        }
        fs.writeFileSync(plist, launchAgentPlist(label, args, log));
        execFileSync("launchctl", ["load", "-w", plist]);
        out(`Mnemo will also start by itself at login (${plist}). Log: ${log}`);
      }
      out(`To remove: mnemo-ctl --vault ${shq(vault.root)} launcher --remove`);
      return;
    }
    case "token": {
      const keys = new TokenStore(vault);
      if (arg === "list" || !arg) {
        const all = keys.list();
        if (!all.length) out("no keys. Create one: mnemo-ctl token add <name> --agent | --person [--read-only]");
        for (const k of all) out(`${k.name.padEnd(24)} ${k.kind.padEnd(6)} ${k.readOnly ? "read-only " : "          "} created ${k.createdAt}`);
        return;
      }
      if (arg === "add" && arg2) {
        if (!kind) throw new VaultError("Say what the key is for: --agent (MCP tools) or --person (the Helix)");
        const secret = keys.add(arg2, kind, readOnly);
        out(secret);
        process.stderr.write(
          `\nKey "${arg2}" (${kind}${readOnly ? ", read-only" : ""}) created. It is shown once, above; store it on that machine only.\n` +
            (kind === "agent"
              ? `Agent setup: MCP URL http://<this Mac>:<port>/mcp, header "Authorization: Bearer <key>". Proposals it makes are recorded as "${arg2}".\n`
              : `Person setup: open http://<this Mac>:<port>/#token=<key> in a browser. Approvals are recorded as "${arg2}".\n`) +
            `Revoke any time: mnemo-ctl token revoke ${arg2}\n`,
        );
        return;
      }
      if (arg === "revoke" && arg2) return out(keys.revoke(arg2) ? `revoked ${arg2}` : `no key named ${arg2}`);
      throw new VaultError("token list | token add <name> --agent|--person [--read-only] | token revoke <name>");
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = 2;
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`mnemo-ctl: ${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
}
