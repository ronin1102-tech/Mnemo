// Bundles each test with the pinned esbuild (helix sources use extensionless imports) and runs
// them on Node's built-in runner. No test-framework dependency; works the same on Windows.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const out = "build-test";
fs.rmSync(out, { recursive: true, force: true });
const tests = fs.readdirSync("test").filter((f) => f.endsWith(".test.ts"));
await build({
  entryPoints: tests.map((f) => path.join("test", f)),
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});
const files = tests.map((f) => path.join(out, f.replace(/\.ts$/, ".mjs")));
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
