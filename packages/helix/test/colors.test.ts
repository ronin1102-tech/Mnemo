import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLORS } from "../src/colors";

const root = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

describe("gold is reserved for agent proposals", () => {
  it("only render.ts/main.ts touch COLORS.gold, and only next to proposal logic", () => {
    for (const f of fs.readdirSync(path.join(root, "src"))) {
      const lines = read("src/" + f).split("\n");
      lines.forEach((l, i) => {
        if (f !== "colors.ts" && (l.includes("COLORS.gold") || l.toLowerCase().includes(COLORS.gold))) {
          expect(l, `${f}:${i + 1}`).toMatch(/proposed/);
        }
      });
    }
  });
  it("the emblem's own gold (MARK_GOLD) is used only inside drawEmblem", () => {
    const src = read("src/render.ts");
    const emblem = src.slice(src.indexOf("export function drawEmblem"), src.indexOf("export interface GraphView"));
    expect(src.replace(emblem, "")).not.toContain("markGold");
    for (const f of fs.readdirSync(path.join(root, "src")).filter((f) => f !== "render.ts" && f !== "colors.ts"))
      expect(read("src/" + f)).not.toContain("markGold");
  });
  it("CSS uses --gold only inside proposal selectors", () => {
    const css = read("style.css");
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/var\(--gold\)/.test(m[2])) expect(m[1]).toMatch(/proposal/);
    }
    expect(css.match(new RegExp(COLORS.gold, "gi"))?.length).toBe(1); // the token definition
    expect(css.toLowerCase()).not.toContain(COLORS.markGold);
  });
});
