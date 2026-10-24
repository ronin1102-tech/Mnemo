#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "./bridge.js";
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

--read-only refuses approve, reject and purge-trash (and removes them from the UI).
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
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") vaultDir = argv[++i];
    else if (argv[i] === "--read-only") readOnly = true;
    else if (argv[i] === "--out") outFile = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--no-open") noOpen = true;
    else if (argv[i] === "--ui") uiOverride = argv[++i];
    else args.push(argv[i]);
  }
  const [cmd, arg] = args;
  if (!cmd || cmd === "help") return void process.stderr.write(USAGE);
  if (!vaultDir) throw new VaultError("No vault: pass --vault <dir> or set MNEMO_VAULT");
  const mutating = ["approve", "reject", "purge-trash"].includes(cmd);
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
    case "ui": {
      const uiDir = uiOverride ? path.resolve(uiOverride) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "helix", "dist");
      if (!fs.existsSync(path.join(uiDir, "index.html"))) throw new VaultError(`Helix UI not built in ${uiDir}: run \`npm run build\` first`);
      startBridge(vault, { port, uiDir, readOnly })
        .then((b) => {
          process.stderr.write(`mnemo: Helix UI for ${vault.root}${readOnly ? " (read-only)" : ""}\n  ${b.url}\n  local only (127.0.0.1). The link holds this session's key: don't share it. Ctrl+C to stop.\n`);
          if (!noOpen) openBrowser(b.url);
        })
        .catch((e) => {
          process.stderr.write(`mnemo-ctl: ${e && e.code === "EADDRINUSE" ? `port ${port} is in use; try --port <n>` : e instanceof Error ? e.message : e}\n`);
          process.exitCode = 1;
        });
      return;
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
