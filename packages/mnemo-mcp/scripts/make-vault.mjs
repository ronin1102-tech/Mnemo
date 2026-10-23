// Usage: node scripts/make-vault.mjs <dir> [notes=10000]
// Synthetic vault: folders, frontmatter tags/created spread over ~3 years, wikilinks and markdown links.
import fs from "node:fs";
import path from "node:path";

const [dir, n = "10000"] = process.argv.slice(2);
if (!dir) {
  console.error("usage: make-vault.mjs <dir> [notes]");
  process.exit(2);
}
const N = Number(n);
let seed = 7;
const rnd = (m) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % m);
const words = "memory graph helix vault agent proposal index search link note daily project idea reading meeting garden sqlite canvas strand rung time".split(" ");
const now = Date.now();
for (let i = 0; i < N; i++) {
  const d = path.join(dir, `folder${i % 40}`);
  fs.mkdirSync(d, { recursive: true });
  const created = new Date(now - (N - i) * (3 * 365 * 86400000) / N).toISOString().slice(0, 10);
  const links = Array.from({ length: 1 + rnd(4) }, () => (rnd(3) ? `[[note-${rnd(N)}]]` : `[ref](../folder${rnd(40)}/note-${rnd(N)}.md)`)).join(" ");
  const body = Array.from({ length: 120 }, () => words[rnd(words.length)]).join(" ");
  fs.writeFileSync(path.join(d, `note-${i}.md`), `---\ntitle: Note ${i}\ntags: [tag${rnd(30)}, tag${rnd(30)}]\ncreated: ${created}\n---\n${body}\n\n${links}\n`);
}
console.log(`wrote ${N} notes to ${dir}`);
