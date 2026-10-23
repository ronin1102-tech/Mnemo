import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "./expect.js";

/**
 * Catalina guard. The floor is macOS 10.15 + Node 20, and native binaries carry their own
 * minimum macOS (measured from each Mach-O's LC_VERSION_MIN / LC_BUILD_VERSION):
 *   esbuild <= 0.23.x -> 10.13; 0.24+ -> 11.0; 0.28 -> 12.0
 *   TypeScript 7's native tsc -> 12.0 (TypeScript 5.x is plain JavaScript)
 *   better-sqlite3 12.9.0 -> prebuilt Node 20 binaries, macOS x64 min 10.7; 12.10+ ships none for Node 20
 * This fails the build if a dependency upgrade quietly reintroduces any of them.
 */
type Lock = { packages: Record<string, { version?: string; engines?: { node?: string } | string[] }> };
const locks: [string, Lock][] = [
  ["mnemo-mcp", JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8"))],
  ["helix", JSON.parse(fs.readFileSync(path.resolve("../helix/package-lock.json"), "utf8"))],
];
const entries = () => locks.flatMap(([pkg, lock]) => Object.entries(lock.packages).filter(([k]) => k).map(([k, v]) => ({ pkg, name: k.replace(/^.*node_modules\//, ""), ...v })));
const ver = (v = "0.0.0") => v.split(".").map(Number);

describe("toolchain stays Catalina + Node 20 compatible", () => {
  it("esbuild (any copy) is 0.23.x or older", () => {
    for (const e of entries().filter((e) => e.name === "esbuild" || e.name.startsWith("@esbuild/"))) {
      const [maj, min] = ver(e.version);
      expect(maj === 0 && min <= 23, `${e.pkg}: ${e.name}@${e.version} needs macOS 11+`).toBe(true);
    }
  });
  it("no native TypeScript (7.x) and no vite/vitest/rollup stack", () => {
    for (const e of entries()) {
      expect(e.name.startsWith("@typescript/typescript-"), `${e.pkg}: ${e.name}`).toBe(false);
      if (e.name === "typescript") expect(ver(e.version)[0], `${e.pkg}: typescript@${e.version}`).toBe(5);
      expect(["vite", "vitest", "rollup"].includes(e.name), `${e.pkg}: ${e.name} is back`).toBe(false);
    }
  });
  it("better-sqlite3 is exactly 12.9.0 (last release with prebuilt Node 20 binaries)", () => {
    const b = entries().filter((e) => e.name === "better-sqlite3");
    expect(b.length).toBe(1);
    expect(b[0].version).toBe("12.9.0");
  });
  it("every package's engines field accepts Node 20", () => {
    for (const e of entries()) {
      const n = e.engines && !Array.isArray(e.engines) ? e.engines.node : undefined;
      if (!n) continue;
      const accepts = n.split("||").some((r) => {
        const s = r.trim();
        if (s === "*" || /^>=\s*(\d+)/.test(s) && Number(s.match(/^>=\s*(\d+)/)![1]) <= 20) return true;
        if (/^\^?20(\.|$)|^20\.x$|^\^?20\.\d/.test(s)) return true;
        const m = s.match(/^>=?\s*(\d+)(?:\.\d+)*\s+<\s*(\d+)/);
        return !!m && Number(m[1]) <= 20 && Number(m[2]) > 20;
      });
      expect(accepts, `${e.pkg}: ${e.name}@${e.version} engines "${n}"`).toBe(true);
    }
  });
});
