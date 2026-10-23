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
    const p = store.propose("write", "a.md", "changed", "claude");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("one\ntwo");
    expect(p.client).toBe("claude");
    expect(p.diff).toContain("+ changed");
    expect(fs.existsSync(path.join(root, ".mnemo/proposals", `${p.id}.json`))).toBe(true);
  });

  it("approve applies; append and create work", () => {
    const { root, store } = setup();
    store.approve(store.propose("append", "a.md", "three", "c").id);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("one\ntwo\nthree");
    store.approve(store.propose("write", "new/n.md", "# N", "c").id);
    expect(fs.readFileSync(path.join(root, "new/n.md"), "utf8")).toBe("# N");
  });

  it("refuses a stale proposal", () => {
    const { root, store } = setup();
    const p = store.propose("write", "a.md", "x", "c");
    fs.writeFileSync(path.join(root, "a.md"), "human edit");
    expect(() => store.approve(p.id)).toThrow(/changed since/);
  });

  it("expires after 7 days and cannot be approved", () => {
    const { store, clock } = setup();
    const p = store.propose("write", "a.md", "x", "c");
    clock.advance(PROPOSAL_TTL_MS - 1000);
    expect(store.get(p.id).status).toBe("pending");
    clock.advance(2000);
    expect(store.get(p.id).status).toBe("expired");
    expect(() => store.approve(p.id)).toThrow(/expired/);
  });

  it("delete moves to .mnemo/trash; only purge destroys", () => {
    const { root, store } = setup();
    store.approve(store.propose("delete", "a.md", null, "c").id);
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(false);
    const trash = fs.readdirSync(path.join(root, ".mnemo/trash"));
    expect(trash).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, ".mnemo/trash", trash[0]), "utf8")).toBe("one\ntwo");
    expect(store.purgeTrash()).toBe(1);
  });

  it("jail applies to proposals", () => {
    const { store } = setup();
    expect(() => store.propose("write", "../evil.md", "x", "c")).toThrow();
    expect(() => store.propose("write", "/tmp/evil.md", "x", "c")).toThrow();
  });
});
