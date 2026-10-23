import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS } from "../src/colors";

const root = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const srcFiles = () => fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".ts") && f !== "colors.ts");

/** Body of a named function in a source file. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name} exists`).toBeGreaterThanOrEqual(0);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

describe("gold is reserved for agent proposals", () => {
  it("proposal gold (COLORS.gold) is used only inside render.ts proposedMarker", () => {
    for (const f of srcFiles()) {
      let src = read("src/" + f);
      if (f === "render.ts") src = src.replace(fnBody(src, "proposedMarker"), "");
      expect(src, f).not.toContain("COLORS.gold");
      expect(src.toLowerCase(), f).not.toContain(COLORS.gold);
    }
  });
  it("the mark's own gold (COLORS.markGold) is used only in emblem.ts, the branding surface", () => {
    for (const f of srcFiles().filter((f) => f !== "emblem.ts")) {
      expect(read("src/" + f), f).not.toContain("markGold");
      expect(read("src/" + f).toLowerCase(), f).not.toContain(COLORS.markGold);
    }
  });
  it("CSS uses --gold only inside proposal selectors, and never the mark's gold", () => {
    const css = read("style.css");
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/var\(--gold\)/.test(m[2])) expect(m[1]).toMatch(/proposal/);
    }
    expect(css.match(new RegExp(COLORS.gold, "gi"))?.length).toBe(1); // the token definition
    expect(css.toLowerCase()).not.toContain(COLORS.markGold);
  });
  it("the page markup carries no gold", () => {
    const html = read("index.html").toLowerCase();
    expect(html).not.toContain(COLORS.gold);
    expect(html).not.toContain(COLORS.markGold);
  });
});
