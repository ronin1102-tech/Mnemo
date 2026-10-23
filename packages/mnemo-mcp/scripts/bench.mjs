// Budgets @ 10k notes: start <1s, search <200ms, idle RSS <128MB (raised from 50MB: Node + MCP SDK floor is ~76MB), cold index <30s.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const N = Number(process.env.BENCH_NOTES || 10000);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const words = "memory graph helix vault agent proposal index search markdown link note daily project idea reading meeting garden sqlite canvas strand rung time".split(" ");
let seed = 42;
const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n);
const sentence = (n) => Array.from({ length: n }, () => words[rnd(words.length)]).join(" ");

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-bench-"));
for (let i = 0; i < N; i++) {
  const dir = path.join(vault, `folder${i % 50}`);
  fs.mkdirSync(dir, { recursive: true });
  const links = Array.from({ length: 4 }, () => `[[note-${rnd(N)}]]`).join(" ");
  fs.writeFileSync(path.join(dir, `note-${i}.md`), `# Note ${i} ${sentence(3)}\n\n${sentence(250)}\n\n${links} #tag${rnd(40)}\n`);
}
const results = [];
const check = (name, value, limit, unit) => {
  const ok = value < limit;
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${value.toFixed(0)}${unit} (budget < ${limit}${unit})`);
};

let t = Date.now();
execFileSync("node", [path.join(dist, "ctl.js"), "--vault", vault, "reindex"]);
check(`cold index of ${N} notes`, Date.now() - t, 30000, "ms");

const client = new Client({ name: "bench", version: "1" });
const transport = new StdioClientTransport({ command: "node", args: [...(process.env.BENCH_NODE_FLAGS || "").split(" ").filter(Boolean), path.join(dist, "cli.js"), "--vault", vault, "serve"] });
t = Date.now();
await client.connect(transport); // resolves once the server answered initialize
check("server start (spawn -> initialized)", Date.now() - t, 1000, "ms");

const lat = [];
const first = Date.now();
await client.callTool({ name: "search_notes", arguments: { query: "helix memory" } });
const firstMs = Date.now() - first;
for (let i = 0; i < 40; i++) {
  const s = process.hrtime.bigint();
  await client.callTool({ name: "search_notes", arguments: { query: `${words[rnd(words.length)]} ${words[rnd(words.length)]}` } });
  lat.push(Number(process.hrtime.bigint() - s) / 1e6);
}
lat.sort((a, b) => a - b);
console.log(`      first search ${firstMs}ms, median ${lat[20].toFixed(1)}ms`);
check("search p95", lat[Math.floor(lat.length * 0.95)], 200, "ms");

await new Promise((r) => setTimeout(r, 2000));
const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(transport.pid)]).toString().trim()) / 1024;
check("idle RSS", rss, 128, "MB");

await client.close();
fs.rmSync(vault, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
