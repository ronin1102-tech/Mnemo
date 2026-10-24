import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });
// Safari 13 (macOS 10.15 Catalina) is the floor. It supports ES2019 natively; esbuild lowers ?. and ?? for es2019.
await build({ entryPoints: ["src/main.ts"], bundle: true, outfile: "dist/app.js", target: ["es2019"], format: "iife", minify: true });
for (const f of ["index.html", "style.css"]) fs.copyFileSync(f, `dist/${f}`);
// the logo (rendered from the emblem by scripts/render-icons.mjs, committed in assets/)
for (const f of ["icon-32.png", "icon-180.png", "brand-64.png", "mnemo.icns"]) fs.copyFileSync(`assets/${f}`, `dist/${f}`);
console.log("built dist/");
