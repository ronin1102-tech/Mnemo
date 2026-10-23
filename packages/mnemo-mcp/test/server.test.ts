import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, localDate } from "../src/server.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

async function connect(files: Record<string, string>, opts: { readOnly?: boolean } = {}) {
  const root = tmpVault(files);
  const { server } = createServer(new Vault(root), opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const t = r.content[0].text as string;
    let data: any = t;
    try { data = JSON.parse(t); } catch {}
    return { isError: !!r.isError, data };
  };
  return { root, client, call };
}

describe("mnemo mcp server", () => {
  it("exposes the read tools and gated write tools, with no approve/bypass", async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["append_note", "daily_note", "delete_note", "find_similar", "get_backlinks", "get_neighbors", "get_tags", "list_notes", "list_proposals", "list_recent", "move_note", "patch_note", "read_note", "search_notes", "write_note"],
    );
  });

  it("searches, reads, lists and finds backlinks", async () => {
    const { call } = await connect({
      "ideas/helix.md": "# Helix\nA double strand of memory. See [[Mnemo]].",
      "Mnemo.md": "# Mnemo\nSecond brain #project",
      "inbox.md": "link to [[mnemo|the brain]] and [[Helix#top]]",
    });
    expect((await call("search_notes", { query: "doub" })).data[0].path).toBe("ideas/helix.md");
    expect((await call("read_note", { path: "Mnemo.md" })).data.content).toContain("Second brain");
    expect((await call("list_notes", { folder: "ideas" })).data).toHaveLength(1);
    expect((await call("list_recent", { limit: 2 })).data).toHaveLength(2);
    const bl = (await call("get_backlinks", { path: "Mnemo.md" })).data.map((n: any) => n.path).sort();
    expect(bl).toEqual(["ideas/helix.md", "inbox.md"]);
  });

  it("picks up edits made on disk between calls", async () => {
    const { root, call } = await connect({ "a.md": "alpha" });
    fs.writeFileSync(path.join(root, "b.md"), "bravo");
    expect((await call("search_notes", { query: "bravo" })).data).toHaveLength(1);
  });

  it("daily_note is read-only", async () => {
    const { root, call } = await connect({});
    const r = await call("daily_note");
    expect(r.data).toEqual({ path: `daily/${localDate()}.md`, exists: false, content: null });
    expect(fs.existsSync(path.join(root, "daily"))).toBe(false);
  });

  it("jail errors surface as tool errors", async () => {
    const { call } = await connect({ "a.md": "x" });
    for (const p of ["/etc/passwd", "../a.md", ".mnemo/index.db"]) expect((await call("read_note", { path: p })).isError).toBe(true);
  });

  it("writes only create proposals, recording the client", async () => {
    const { root, call } = await connect({ "a.md": "old" });
    const r = await call("write_note", { path: "a.md", content: "new" });
    expect(r.data.status).toBe("pending");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("old");
    const list = (await call("list_proposals", { status: "pending" })).data;
    expect(list).toHaveLength(1);
    expect(list[0].client).toBe("test-agent");
    await call("delete_note", { path: "a.md" });
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(true);
  });

  it("--read-only registers no write tools", async () => {
    const { client } = await connect({}, { readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("write_note");
    expect(names.filter((n) => /write|append|patch|move|delete/.test(n))).toEqual([]);
    expect(names).toContain("search_notes");
  });

  it("patch_note and move_note go through the gate", async () => {
    const { root, call } = await connect({ "a.md": "hello world", "b.md": "[[a]]" });
    expect((await call("patch_note", { path: "a.md", anchor: "zzz", replacement: "x" })).isError).toBe(true);
    const r = await call("move_note", { from: "a.md", to: "c.md" });
    expect(r.data.status).toBe("pending");
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(true);
  });

  it("get_neighbors, get_tags and find_similar", async () => {
    const { call } = await connect({
      "hub.md": "# Hub\n[[a]] [[b]] #topic",
      "a.md": "# A\n[[shared]] #topic",
      "b.md": "# B\n[[shared]] #other",
      "shared.md": "# Shared",
      "lone.md": "# Lone [[missing]]",
    });
    const n = (await call("get_neighbors", { path: "a.md", depth: 2 })).data;
    expect(n.outgoing.map((x: any) => x.path)).toEqual(["shared.md"]);
    expect(n.incoming.map((x: any) => x.path)).toEqual(["hub.md"]);
    expect(n.nodes.map((x: any) => x.path).sort()).toEqual(["b.md", "hub.md", "shared.md"]);
    expect((await call("get_neighbors", { path: "lone.md" })).data.unresolved).toEqual(["missing"]);
    expect((await call("get_tags")).data).toEqual([{ tag: "topic", count: 2 }, { tag: "other", count: 1 }]);
    expect((await call("get_tags", { tag: "#topic" })).data).toHaveLength(2);
    const sim = (await call("find_similar", { path: "a.md" })).data;
    expect(sim[0].path).toBe("b.md"); // same outgoing link + same linker
    expect(sim[0].score).toBeGreaterThan(0.3);
    expect(sim[0].reasons.join(" ")).toMatch(/links to the same/);
    expect((await call("find_similar", { path: "nope.md" })).isError).toBe(true);
  });
});
