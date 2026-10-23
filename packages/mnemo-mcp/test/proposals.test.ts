import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_TTL_MS, ProposalStore } from "../src/proposals.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

const setup = (files: Record<string, string> = { "a.md": "one\ntwo" }) => {
  const root = tmpVault(files);
  let t = 1_700_000_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  return { root, vault: new Vault(root), store: new ProposalStore(new Vault(root), () => t), clock };
};

describe("write gate", () => {
  it("proposing never touches the note", () => {
    const { root, store } = setup();
    const p = store.proposeWrite("a.md", "changed", "claude");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("one\ntwo");
    expect(p.client).toBe("claude");
    expect(p.diff).toContain("+ changed");
    expect(fs.existsSync(path.join(root, ".mnemo/proposals", `${p.id}.json`))).toBe(true);
  });

  it("approve applies; append and create work", () => {
    const { root, store } = setup();
    store.approve(store.proposeAppend("a.md", "three", "c").id);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("one\ntwo\nthree");
    store.approve(store.proposeWrite("new/n.md", "# N", "c").id);
    expect(fs.readFileSync(path.join(root, "new/n.md"), "utf8")).toBe("# N");
  });

  it("refuses a stale proposal", () => {
    const { root, store } = setup();
    const p = store.proposeWrite("a.md", "x", "c");
    fs.writeFileSync(path.join(root, "a.md"), "human edit");
    expect(() => store.approve(p.id)).toThrow(/stale/);
    expect(store.get(p.id).status).toBe("stale");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("human edit");
  });

  it("expires after 7 days and cannot be approved", () => {
    const { store, clock } = setup();
    const p = store.proposeWrite("a.md", "x", "c");
    clock.advance(PROPOSAL_TTL_MS - 1000);
    expect(store.get(p.id).status).toBe("pending");
    clock.advance(2000);
    expect(store.get(p.id).status).toBe("expired");
    expect(() => store.approve(p.id)).toThrow(/expired/);
  });

  it("delete moves to .mnemo/trash; only purge destroys", () => {
    const { root, store } = setup();
    store.approve(store.proposeDelete("a.md", "c").id);
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(false);
    const trash = fs.readdirSync(path.join(root, ".mnemo/trash"));
    expect(trash).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, ".mnemo/trash", trash[0]), "utf8")).toBe("one\ntwo");
    expect(store.purgeTrash()).toBe(1);
  });

  it("jail applies to proposals", () => {
    const { store } = setup();
    expect(() => store.proposeWrite("../evil.md", "x", "c")).toThrow();
    expect(() => store.proposeWrite("/tmp/evil.md", "x", "c")).toThrow();
  });

  it("patch replaces exactly one anchor and fails closed otherwise", () => {
    const { root, store } = setup({ "a.md": "alpha beta\nbeta gamma" });
    expect(() => store.proposePatch("a.md", "nope", "x", "c")).toThrow(/not found/);
    expect(() => store.proposePatch("a.md", "beta", "x", "c")).toThrow(/more than once/);
    expect(() => store.proposePatch("a.md", "", "x", "c")).toThrow();
    expect(fs.readdirSync(path.join(root, ".mnemo/proposals"))).toHaveLength(0);
    store.approve(store.proposePatch("a.md", "alpha beta", "ALPHA", "c").id);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("ALPHA\nbeta gamma");
  });

  it("move renames and rewrites inbound wikilinks atomically with the move", () => {
    const { root, store } = setup({
      "old.md": "# Old",
      "x.md": "see [[old]] and [[old|the old one]] and [[old#Sec]] and [[Old.md]]",
      "y.md": "path form [[notes/old]]",
      "z.md": "unrelated [[other]]",
    });
    const p = store.proposeMove("old.md", "archive/renamed.md", "c");
    expect(p.changes.map((c) => c.path).sort()).toEqual(["old.md", "x.md", "y.md"]);
    expect(fs.existsSync(path.join(root, "old.md"))).toBe(true); // nothing yet
    store.approve(p.id);
    expect(fs.existsSync(path.join(root, "old.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "archive/renamed.md"), "utf8")).toBe("# Old");
    expect(fs.readFileSync(path.join(root, "x.md"), "utf8")).toBe("see [[renamed]] and [[renamed|the old one]] and [[renamed#Sec]] and [[renamed.md]]");
    expect(fs.readFileSync(path.join(root, "z.md"), "utf8")).toBe("unrelated [[other]]");
  });

  it("move leaves links alone when they still resolve, and rejects bad targets", () => {
    const { store } = setup({ "a/n.md": "n", "b.md": "[[n]]", "c.md": "c" });
    const p = store.proposeMove("a/n.md", "z/n.md", "c");
    expect(p.changes).toHaveLength(1); // basename unchanged: no rewrites needed
    expect(() => store.proposeMove("c.md", "b.md", "c")).toThrow(/exists/);
    expect(() => store.proposeMove("c.md", "../out.md", "c")).toThrow();
  });

  it("a move halts entirely if any rewritten note changed", () => {
    const { root, store } = setup({ "old.md": "o", "x.md": "[[old]]" });
    const p = store.proposeMove("old.md", "new.md", "c");
    fs.writeFileSync(path.join(root, "x.md"), "[[old]] edited");
    expect(() => store.approve(p.id)).toThrow(/stale/);
    expect(fs.existsSync(path.join(root, "old.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "new.md"))).toBe(false);
  });

  it("writes are atomic: no temp files left, content replaced whole", () => {
    const { root, store } = setup();
    store.approve(store.proposeWrite("a.md", "x".repeat(100000), "c").id);
    expect(fs.readdirSync(root).filter((f) => f.includes("mnemo-tmp"))).toEqual([]);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toHaveLength(100000);
  });

  it("move rewrites relative markdown links from each note's own directory", () => {
    const { root, store } = setup({
      "old.md": "# Old",
      "x.md": "[a](old.md) [b](./old.md#h) [c](http://e.com/old.md)",
      "dir/y.md": "[up](../old.md)",
    });
    store.approve(store.proposeMove("old.md", "deep/er/new.md", "c").id);
    expect(fs.readFileSync(path.join(root, "x.md"), "utf8")).toBe("[a](deep/er/new.md) [b](./deep/er/new.md#h) [c](http://e.com/old.md)");
    expect(fs.readFileSync(path.join(root, "dir/y.md"), "utf8")).toBe("[up](../deep/er/new.md)");
  });

  it("refuses to patch a note over the 10MB cap", () => {
    const { root, store } = setup({ "big.md": "needle " + "x".repeat(10_000_001) });
    expect(() => store.proposePatch("big.md", "needle", "y", "c")).toThrow(/10MB/);
    expect(fs.readdirSync(path.join(root, ".mnemo/proposals"))).toHaveLength(0);
  });
});
