import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, localDate } from "../src/server.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

async function connect(files: Record<string, string>) {
  const root = tmpVault(files);
  const { server } = createServer(new Vault(root));
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
      ["daily_note", "get_backlinks", "list_notes", "list_proposals", "list_recent", "propose_append", "propose_delete", "propose_write", "read_note", "search_notes"],
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
    const r = await call("propose_write", { path: "a.md", content: "new" });
    expect(r.data.status).toBe("pending");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("old");
    const list = (await call("list_proposals", { status: "pending" })).data;
    expect(list).toHaveLength(1);
    expect(list[0].client).toBe("test-agent");
    await call("propose_delete", { path: "a.md" });
    expect(fs.existsSync(path.join(root, "a.md"))).toBe(true);
  });
});
