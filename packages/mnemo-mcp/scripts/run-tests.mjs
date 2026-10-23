// Runs the compiled tests on Node's built-in runner (no test-framework dependency).
// Lists files itself rather than relying on shell globs, so it works the same on Windows.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "build-test/test";
const files = fs.readdirSync(dir).filter((f) => /\.test\.m?js$/.test(f)).map((f) => path.join(dir, f));
if (!files.length) {
  console.error(`no compiled tests in ${dir}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
