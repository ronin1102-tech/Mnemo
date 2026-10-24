// Dev-only: renders the Mnemo logo (the emblem, drawn by src/emblem.ts) to PNGs and a macOS .icns.
// Needs Playwright + Chromium, so it is NOT part of `npm run build`; its outputs are committed in assets/.
// Usage: node scripts/render-icons.mjs [path-to-chromium]
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const out = "assets";
const bundle = await build({
  stdin: {
    contents: `
      import { drawEmblem } from "./src/emblem";
      import { TIERS } from "./src/fx";
      window.renderIcon = (size, minimal) => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d");
        const R = size * 0.44;
        // deep-navy disc behind the mark, so it reads on light and dark Docks alike
        const disc = g.createRadialGradient(size / 2, size * 0.42, 0, size / 2, size / 2, R * 1.04);
        disc.addColorStop(0, "#0d1d4a");
        disc.addColorStop(1, "#050c24");
        g.fillStyle = disc;
        g.beginPath();
        g.arc(size / 2, size / 2, R * 1.04, 0, Math.PI * 2);
        g.fill();
        // a still moment of the living emblem: no motes below 64 px, where they'd be noise
        drawEmblem(g, { w: size, h: size }, 0.55, 1, 1, size >= 64 ? TIERS[2] : TIERS[1], 1, { minimal });
        return c.toDataURL("image/png");
      };`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2019",
});
const require = createRequire(import.meta.url);
let chromium;
try {
  chromium = require("playwright").chromium;
} catch {
  chromium = createRequire("/node-tools/node_modules/")("playwright").chromium;
}
const browser = await chromium.launch(process.argv[2] ? { executablePath: process.argv[2] } : {});
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
await page.addScriptTag({ content: bundle.outputFiles[0].text });
// at 48 px and below the simplified mark is used: the full ring's detail turns to noise
const png = async (size, minimal = size <= 48) => Buffer.from((await page.evaluate(([s, m]) => window.renderIcon(s, m), [size, minimal])).split(",")[1], "base64");

fs.mkdirSync(out, { recursive: true });
const sizes = [16, 32, 64, 128, 180, 256, 512, 1024];
const pngs = {};
for (const s of sizes) {
  pngs[s] = await png(s);
  fs.writeFileSync(path.join(out, `icon-${s}.png`), pngs[s]);
}
// header mark: shown at ~26 px, so the simplified design at 2x resolution
fs.writeFileSync(path.join(out, "brand-64.png"), await png(64, true));
// .icns: "icns" + length, then (type, length, PNG) chunks. PNG chunks work on macOS 10.7+.
// the @2x slots for the smallest sizes keep the simplified design of the size they stand in for
const small2x = { 32: await png(32, true), 64: await png(64, true) };
const types = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32, small2x[32]], ["ic12", 64, small2x[64]], ["ic13", 256], ["ic14", 512]];
const chunks = types.map(([t, s, data]) => {
  const bytes = data || pngs[s];
  const h = Buffer.alloc(8);
  h.write(t, 0, "ascii");
  h.writeUInt32BE(8 + bytes.length, 4);
  return Buffer.concat([h, bytes]);
});
const body = Buffer.concat(chunks);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(8 + body.length, 4);
fs.writeFileSync(path.join(out, "mnemo.icns"), Buffer.concat([head, body]));
await browser.close();
console.log(`wrote ${sizes.map((s) => `icon-${s}.png`).join(", ")} and mnemo.icns (${8 + body.length} bytes) to ${out}/`);
