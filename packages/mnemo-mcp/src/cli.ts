#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { Vault, VaultError } from "./vault.js";

/**
 * The SDK's stdio buffer defaults to 10 MiB and an overflow closes the transport, ending the
 * server silently. A 10 MB note (the app's cap) is larger than that once JSON-escaped, so the
 * transport must accept more than the app does; the app then refuses cleanly with an error result.
 */
const STDIO_MAX_MESSAGE = 64 * 1024 * 1024;

const USAGE = `mnemo-mcp [--vault <dir>] [--read-only] serve    (vault also via MNEMO_VAULT; MNEMO_READ_ONLY=1)

  Runs the MCP server on stdio: no network, no ports.
  --read-only   register no write tools at all
Human admin (approve/reject proposals, reindex) lives in the separate mnemo-ctl.
`;

function main(argv: string[]) {
  let vaultDir = process.env.MNEMO_VAULT;
  let readOnly = process.env.MNEMO_READ_ONLY === "1";
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault") vaultDir = argv[++i];
    else if (argv[i] === "--read-only") readOnly = true;
    else args.push(argv[i]);
  }
  if (args[0] !== "serve") return void process.stderr.write(USAGE);
  if (!vaultDir) throw new VaultError("No vault: pass --vault <dir> or set MNEMO_VAULT");
  const vault = new Vault(path.resolve(vaultDir));
  const { server } = createServer(vault, { readOnly });
  server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_MESSAGE })).then(() => process.stderr.write(`mnemo: serving ${vault.root}${readOnly ? " (read-only)" : ""}\n`));
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`mnemo: ${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
}
