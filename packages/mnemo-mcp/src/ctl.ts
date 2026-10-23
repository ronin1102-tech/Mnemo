#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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

--read-only refuses approve, reject and purge-trash.
`;

function main(argv: string[]) {
  let vaultDir = process.env.MNEMO_VAULT;
  let readOnly = process.env.MNEMO_READ_ONLY === "1";
  let outFile: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") vaultDir = argv[++i];
    else if (argv[i] === "--read-only") readOnly = true;
    else if (argv[i] === "--out") outFile = argv[++i];
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
      return out(`${p.id} ${p.status} ${p.op} ${p.path}${p.to ? " -> " + p.to : ""}\nclient: ${p.client}\ncreated: ${p.createdAt}\nexpires: ${p.expiresAt}\ntouches: ${p.changes.map((c) => c.path).join(", ")}\n\n${p.diff}`);
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
      const pending = store.list("pending").map((p) => ({ id: p.id, path: p.path, op: p.op, client: p.client }));
      const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...index.graph(), proposals: pending });
      index.close();
      if (outFile) fs.writeFileSync(outFile, `window.__MNEMO_GRAPH__ = ${json};\n`);
      else out(json);
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
