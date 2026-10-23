#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Index } from "./indexer.js";
import { ProposalStore } from "./proposals.js";
import { createServer } from "./server.js";
import { Vault, VaultError } from "./vault.js";

const USAGE = `mnemo-mcp [--vault <dir>] <command>      (vault also via MNEMO_VAULT)

  serve                          Run the MCP server on stdio (no network, no ports)
  proposals list [status]        List agent write proposals
  proposals show <id>            Show a proposal with its diff
  proposals approve <id>         Apply a proposal to the vault (human only)
  proposals reject <id>          Discard a proposal
  purge-trash                    Permanently delete .mnemo/trash (human only)
  export-graph [--out file.js]   Write graph data for the Helix UI (default: stdout JSON)
`;

function main(argv: string[]) {
  let vaultDir = process.env.MNEMO_VAULT;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") vaultDir = argv[++i];
    else args.push(argv[i]);
  }
  const [cmd, sub, arg] = args;
  if (!cmd || cmd === "help" || cmd === "--help") return void process.stderr.write(USAGE);
  if (!vaultDir) throw new VaultError("No vault: pass --vault <dir> or set MNEMO_VAULT");
  const vault = new Vault(path.resolve(vaultDir));
  const out = (s: string) => process.stdout.write(s + "\n");

  switch (cmd) {
    case "serve": {
      const { server } = createServer(vault);
      return void server.connect(new StdioServerTransport()).then(() => process.stderr.write(`mnemo: serving ${vault.root}\n`));
    }
    case "proposals": {
      const store = new ProposalStore(vault);
      if (sub === "list") {
        for (const p of store.list(arg as any)) out(`${p.id}  ${p.status.padEnd(8)}  ${p.op.padEnd(6)}  ${p.path}  (${p.client}, expires ${p.expiresAt})`);
      } else if (sub === "show" && arg) {
        const p = store.get(arg);
        out(`${p.id} ${p.status} ${p.op} ${p.path}\nclient: ${p.client}\ncreated: ${p.createdAt}\nexpires: ${p.expiresAt}\n\n${p.diff}`);
      } else if (sub === "approve" && arg) out(`approved ${store.approve(arg).path}`);
      else if (sub === "reject" && arg) out(`rejected ${store.reject(arg).path}`);
      else process.stderr.write(USAGE);
      return;
    }
    case "purge-trash":
      return out(`purged ${new ProposalStore(vault).purgeTrash()} file(s)`);
    case "export-graph": {
      const index = new Index(vault);
      index.sync();
      const pending = new ProposalStore(vault).list("pending").map((p) => ({ id: p.id, path: p.path, op: p.op, client: p.client }));
      const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...index.graph(), proposals: pending });
      index.close();
      const o = args.indexOf("--out");
      if (o >= 0) fs.writeFileSync(args[o + 1], `window.__MNEMO_GRAPH__ = ${json};\n`);
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
  process.stderr.write(`mnemo: ${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
}
