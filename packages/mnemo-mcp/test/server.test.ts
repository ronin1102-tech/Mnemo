import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "./expect.js";
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
      ["append_note", "daily_note", "delete_note", "find_similar", "get_backlinks", "get_neighbors", "get_tags", "list_notes", "list_proposals", "list_recent", "list_requests", "move_note", "patch_note", "read_note", "search_notes", "write_note"],
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
    expect((await call("list_notes", { folder: "ideas" })).data.notes).toHaveLength(1);
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

  it("reads frontmatter: tags (all YAML forms), title, and feeds search/tags/similarity", async () => {
    const { call } = await connect({
      "a.md": "---\ntitle: Alpha Note\ntags: [Garden, \"deep-work\"]\ncreated: 2026-01-02\nowner: tracy\n---\nBody about zebras.",
      "b.md": "---\ntags:\n  - garden\n  - '#misc'\n---\n# Beta\nInline #garden too",
      "c.md": "---\ntags: garden, other\n---\nplain",
      "d.md": "no frontmatter #solo",
    });
    expect((await call("get_tags")).data).toEqual([
      { tag: "garden", count: 3 }, { tag: "deep-work", count: 1 }, { tag: "misc", count: 1 }, { tag: "other", count: 1 }, { tag: "solo", count: 1 },
    ]);
    const r = (await call("read_note", { path: "a.md" })).data;
    expect(r.frontmatter).toEqual({ tags: ["garden", "deep-work"], title: "Alpha Note", created: "2026-01-02" });
    expect((await call("search_notes", { query: "alpha" })).data[0].title).toBe("Alpha Note");
    expect((await call("search_notes", { query: "deep" })).data[0].path).toBe("a.md"); // tags are searchable
    const sim = (await call("find_similar", { path: "a.md" })).data;
    expect(sim.map((x: any) => x.path).sort()).toEqual(["b.md", "c.md"]);
    expect(sim[0].reasons.join(" ")).toContain("#garden");
  });

  it("search filters by folder, tag and date; backlinks carry context; list_notes counts folders", async () => {
    const { root, call } = await connect({
      "work/a.md": "kiwi #x\nsee [[b]] for kiwi",
      "work/sub/b.md": "kiwi #y",
      "home/c.md": "kiwi #x",
    });
    fs.utimesSync(path.join(root, "home/c.md"), new Date("2020-01-01"), new Date("2020-01-01"));
    const paths = async (a: Record<string, unknown>) => (await call("search_notes", { query: "kiwi", ...a })).data.map((h: any) => h.path).sort();
    expect(await paths({})).toHaveLength(3);
    expect(await paths({ folder: "work" })).toEqual(["work/a.md", "work/sub/b.md"]);
    expect(await paths({ tag: "x" })).toEqual(["home/c.md", "work/a.md"]);
    expect(await paths({ before: "2021-01-01" })).toEqual(["home/c.md"]);
    expect(await paths({ after: "2021-01-01", tag: "#x" })).toEqual(["work/a.md"]);
    expect((await call("get_backlinks", { path: "work/sub/b.md" })).data[0]).toMatchObject({ path: "work/a.md", context: "see [[b]] for kiwi" });
    expect((await call("list_notes", {})).data.folders).toEqual([{ name: "home", count: 1 }, { name: "work", count: 2 }]);
    expect((await call("read_note", { path: "work/sub/b.md" })).data.backlinks[0].path).toBe("work/a.md");
  });

  it("get_neighbors lists unlinked related notes; relative markdown links are edges", async () => {
    const { call } = await connect({
      "a.md": "# A #t\n[hub](hub.md)",
      "b.md": "# B #t\n[hub](./hub.md#top)",
      "hub.md": "# Hub",
      "dir/c.md": "[up](../hub.md) and [web](https://x.dev/a.md) and [nope](missing.md)",
    });
    expect((await call("get_backlinks", { path: "hub.md" })).data.map((n: any) => n.path).sort()).toEqual(["a.md", "b.md", "dir/c.md"]);
    const n = (await call("get_neighbors", { path: "a.md" })).data;
    expect(n.related.map((r: any) => r.path)).toContain("b.md"); // shares a tag and a link target, but not linked
    expect(n.related.map((r: any) => r.path)).not.toContain("hub.md");
  });

  it("date filters use frontmatter created, falling back to mtime", async () => {
    const { root, call } = await connect({
      "old-created.md": "---\ncreated: 2019-05-01\n---\nquince",
      "no-created.md": "quince",
      "bad-created.md": "---\ncreated: not a date\n---\nquince",
    });
    // all three were just written (mtime = now); only the frontmatter one is "old"
    const hits = async (a: Record<string, unknown>) => (await call("search_notes", { query: "quince", ...a })).data.map((h: any) => h.path).sort();
    expect(await hits({ before: "2020-01-01" })).toEqual(["old-created.md"]);
    expect(await hits({ after: "2020-01-01" })).toEqual(["bad-created.md", "no-created.md"]);
    fs.utimesSync(path.join(root, "no-created.md"), new Date("2018-01-01"), new Date("2018-01-01"));
    expect(await hits({ before: "2020-01-01" })).toEqual(["no-created.md", "old-created.md"]);
  });
});
