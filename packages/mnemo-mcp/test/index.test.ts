import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "./expect.js";
import { Index } from "../src/indexer.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

describe("index is a rebuildable cache", () => {
  it("deleting .mnemo/index.db and rebuilding gives identical results", () => {
    const root = tmpVault({
      "a.md": "---\ntags: [t]\n---\n# Alpha\nzebra [[b]]",
      "b.md": "# Beta\nzebra stripes #t",
      "c/d.md": "# Delta\n[a](../a.md) zebra",
    });
    const snapshot = (ix: Index) => JSON.stringify([ix.search("zebra"), ix.backlinks("a.md"), ix.backlinks("b.md"), ix.tags(), ix.graph(), ix.similar("a.md")]);
    const v = new Vault(root);
    const first = new Index(v);
    first.sync();
    const before = snapshot(first);
    first.close();
    for (const f of fs.readdirSync(path.join(root, ".mnemo")).filter((f) => f.startsWith("index.db"))) fs.rmSync(path.join(root, ".mnemo", f));
    const second = new Index(v);
    second.sync();
    expect(snapshot(second)).toBe(before);
    expect(second.reindex().notes).toBe(3);
    expect(snapshot(second)).toBe(before);
    second.close();
  });
});
