import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge.js";
import { ChatStore, MAX_BODY_CHARS } from "../src/chat.js";
import { ProposalStore } from "../src/proposals.js";
import { createServer } from "../src/server.js";
import { TokenStore } from "../src/tokens.js";
import { Vault } from "../src/vault.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "./expect.js";
import { tmpVault } from "./helpers.js";

const LOCAL = "test-token-0123456789";

function uiDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ui-"));
  for (const f of ["index.html", "app.js", "style.css"]) fs.writeFileSync(path.join(d, f), "x");
  return d;
}

/** A hub on a fresh vault with an owner person key ("tracy"), the chat agent ("cori") and an outsider agent ("vesper"). */
async function hub(files: Record<string, string> = {}, o: { readOnly?: boolean; root?: string; seat?: boolean } = {}) {
  const root = o.root ?? tmpVault(files);
  const vault = new Vault(root);
  const keys = new TokenStore(vault);
  const chat = new ChatStore(vault);
  const have = (n: string) => keys.list().find((k) => k.name === n);
  const secrets: Record<string, string> = {};
  if (!o.root) {
    secrets.tracy = keys.add("tracy", "person");
    secrets.cori = keys.add("cori", "agent");
    secrets.vesper = keys.add("vesper", "agent");
    secrets.office = keys.add("office-pc", "person");
    secrets.viewer = keys.add("viewer", "person", true);
    if (o.seat !== false) {
      const id = (n: string) => ({ name: n, createdAt: have(n)!.createdAt });
      chat.setup({ owner: id("tracy"), agent: id("cori") });
    }
  }
  const b = await startBridge(vault, { port: 0, uiDir: uiDir(), mcp: true, readOnly: o.readOnly, token: LOCAL });
  const req = (p: string, r: { method?: string; body?: unknown; token?: string } = {}) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const q = http.request(
        { host: "127.0.0.1", port: b.port, path: p, method: r.method ?? "GET", headers: { Host: `127.0.0.1:${b.port}`, "X-Mnemo-Token": r.token ?? LOCAL, "Content-Type": "application/json" } },
        (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => {
            let data: any = s;
            try { data = s ? JSON.parse(s) : null; } catch { /* text */ }
            resolve({ status: res.statusCode!, data });
          });
        },
      );
      q.on("error", reject);
      q.end(r.body === undefined ? undefined : JSON.stringify(r.body));
    });
  const send = (body: string, extra: Record<string, unknown> = {}, token?: string) => req("/api/chat/messages", { method: "POST", body: { body, ...extra }, token });
  return { root, vault, keys, chat, b, req, send, secrets, store: new ProposalStore(vault) };
}
type Hub = Awaited<ReturnType<typeof hub>>;

/** Always closes the hub, so a failed assertion can't leave the test run hanging. */
async function withHub(h: Hub, fn: (h: Hub) => Promise<void>) {
  try {
    await fn(h);
  } finally {
    await h.b.close();
  }
}

async function agent(port: number, key: string) {
  const client = new Client({ name: "agent-harness", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let data: any = r.content[0].text;
    try { data = JSON.parse(data); } catch { /* text */ }
    return { isError: !!r.isError, data };
  };
  return { client, call, close: () => client.close() };
}

const listing = (root: string) => {
  const out: string[] = [];
  const walk = (d: string, p: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".mnemo") continue;
      const rel = p ? `${p}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out.push(rel + ":" + fs.readFileSync(path.join(d, e.name), "utf8"));
    }
  };
  walk(root, "");
  return out.sort();
};

describe("copilot chat: the store", () => {
  it("queues, delivers in order with history, answers, and survives a restart", () => {
    const vault = new Vault(tmpVault({}));
    let t = 1_000;
    const chat = new ChatStore(vault, () => (t += 1000));
    const first = chat.send(null, "  First question\nwith detail  ", [{ path: "a.md", title: "A", why: "open" }]);
    expect(first.message.state).toBe("queued");
    expect(first.thread.title).toBe("First question");
    chat.send(first.thread.id, "Second");
    const other = chat.send(null, "Elsewhere");
    expect(chat.status().queued).toBe(3);
    expect(chat.status().lastAgentSeen).toBe(null);

    const again = new ChatStore(vault, () => (t += 1000)); // "restart": a new store on the same folder
    expect(again.status().queued).toBe(3);
    const got = again.fetchQueued(2);
    expect(got.messages.map((m) => m.body)).toEqual(["First question\nwith detail", "Second"]);
    expect(got.remaining).toBe(1);
    expect(got.messages[0].context).toEqual([{ path: "a.md", title: "A", why: "open", excerpt: "" }]);
    expect(got.messages[1].history.map((h) => h.body)).toEqual(["First question\nwith detail"]);
    expect(again.status().lastAgentSeen).not.toBe(null);
    expect(again.getThread(first.thread.id).messages.map((m) => m.state)).toEqual(["delivered", "delivered"]);
    expect(again.fetchQueued(10).messages.map((m) => m.body)).toEqual(["Elsewhere"]);
    expect(again.fetchQueued(10).messages).toEqual([]);

    again.reply(first.thread.id, "Answer", [{ path: "a.md", title: "A" }]);
    expect(again.getThread(first.thread.id).messages.map((m) => m.state ?? m.author)).toEqual(["answered", "answered", "agent"]);
    expect(again.getThread(other.thread.id).messages[0].state).toBe("delivered"); // other conversation untouched
    expect(again.listThreads().map((s) => [s.id, s.queued])).toEqual([[first.thread.id, 0], [other.thread.id, 0]]);
    again.deleteThread(first.thread.id);
    expect(again.listThreads().map((s) => s.id)).toEqual([other.thread.id]);
    expect(() => again.getThread(first.thread.id)).toThrow(/doesn't exist/);
  });
  it("refuses empty or oversized messages and bad ids; the files are private and stay in .mnemo/chat", () => {
    const root = tmpVault({});
    const chat = new ChatStore(new Vault(root));
    expect(() => chat.send(null, "   ")).toThrow(/needs text/);
    expect(() => chat.send(null, "x".repeat(MAX_BODY_CHARS + 1))).toThrow(/at most/);
    expect(() => chat.send("../../etc/passwd", "x")).toThrow(/Invalid/);
    const { thread } = chat.send(null, "hello");
    const f = path.join(root, ".mnemo/chat", thread.id + ".json");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).filter((x) => x !== ".mnemo")).toEqual([]);
  });
  it("pins the seats to a key's name AND creation time", () => {
    const vault = new Vault(tmpVault({}));
    const chat = new ChatStore(vault);
    chat.setup({ owner: { name: "tracy", createdAt: "T1" }, agent: { name: "cori", createdAt: "C1" } });
    expect(chat.isAgentKey({ name: "cori", createdAt: "C1" })).toBe(true);
    expect(chat.isAgentKey({ name: "cori", createdAt: "C2" })).toBe(false); // revoked and re-issued under the same name
    expect(chat.isAgentKey({ name: "vesper", createdAt: "C1" })).toBe(false);
    expect(chat.isOwnerKey({ name: "tracy", createdAt: "T1" })).toBe(true);
  });
});

describe("copilot chat: owner and agent through the hub", () => {
  it("a message waits as queued across a hub restart, then Cori fetches it, answers, and the pane sees it", async () => {
    const h = await hub({ "Plan.md": "# Plan\nThe summer plan is to book the cabin." });
    const secrets = h.secrets;
    let root = h.root;
    let id = "";
    await withHub(h, async () => {
      const r = await h.send("What is in the summer plan?", { open: "Plan.md" }, secrets.tracy);
      expect(r.status).toBe(200);
      expect(r.data.message.state).toBe("queued");
      id = r.data.thread.id;
    });
    // restart the hub on the same vault
    const h2 = await hub({}, { root });
    await withHub(h2, async () => {
      const list = (await h2.req("/api/chat", { token: secrets.tracy })).data;
      expect(list.agent).toBe("cori");
      expect(list.queued).toBe(1);
      expect(list.threads[0].id).toBe(id);
      const cori = await agent(h2.b.port, secrets.cori);
      try {
        const tools = (await cori.client.listTools()).tools.map((t) => t.name);
        expect(tools).toContain("chat_fetch");
        expect(tools).toContain("chat_post");
        const got = (await cori.call("chat_fetch")).data;
        expect(got.messages).toHaveLength(1);
        expect(got.messages[0].body).toBe("What is in the summer plan?");
        expect(got.messages[0].thread).toBe(id);
        expect(got.messages[0].context[0]).toMatchObject({ path: "Plan.md", title: "Plan", why: "open" });
        expect(got.messages[0].context[0].excerpt).toContain("book the cabin");
        expect((await cori.call("chat_fetch")).data.messages).toEqual([]); // marked delivered
        const t1 = (await h2.req(`/api/chat/threads/${id}`, { token: secrets.tracy })).data.thread;
        expect(t1.messages[0].state).toBe("delivered");
        expect((await h2.req("/api/chat", { token: secrets.tracy })).data.lastAgentSeen).not.toBe(null);
        const post = await cori.call("chat_post", { thread: id, body: "You plan to **book the cabin**.", cites: ["Plan.md"] });
        expect(post.isError).toBe(false);
        const t2 = (await h2.req(`/api/chat/threads/${id}`, { token: secrets.tracy })).data.thread;
        expect(t2.messages.map((m: any) => m.state ?? m.author)).toEqual(["answered", "agent"]);
        expect(t2.messages[1].cites).toEqual([{ path: "Plan.md", title: "Plan" }]);
        expect((await cori.call("chat_post", { thread: id, body: "x", cites: ["nope.md"] })).isError).toBe(true); // can't cite a note that isn't there
      } finally {
        await cori.close();
      }
    });
  });
  it("context chips list exactly the notes the fetch attached", async () => {
    const h = await hub({
      "Open.md": "# Open note\nAbout cabins.",
      "Cabin booking.md": "# Cabin booking\nBook the lakeside cabin in June.",
      "Taxes.md": "# Taxes\nNothing relevant here at all.",
    });
    await withHub(h, async () => {
      const r = await h.send("When should I book the lakeside cabin?", { open: "Open.md" }, h.secrets.tracy);
      const chips = r.data.message.context.map((c: any) => [c.path, c.why]);
      expect(chips[0]).toEqual(["Open.md", "open"]);
      expect(chips.map((c: any) => c[0])).toContain("Cabin booking.md");
      expect(chips.map((c: any) => c[0])).not.toContain("Taxes.md");
      expect(chips.length).toBeLessThan(6); // a small fixed cap
      const none = await h.send("When should I book the lakeside cabin?", { related: false }, h.secrets.tracy);
      expect(none.data.message.context).toEqual([]);
      const cori = await agent(h.b.port, h.secrets.cori);
      try {
        const got = (await cori.call("chat_fetch", { limit: 5 })).data.messages;
        expect(got[0].context.map((c: any) => [c.path, c.title, c.why])).toEqual(r.data.message.context.map((c: any) => [c.path, c.title, c.why]));
        expect(got[1].context).toEqual([]);
      } finally {
        await cori.close();
      }
    });
  });
  it("only the named agent is in the channel: another agent key, a re-issued key, and stdio are all refused or absent", async () => {
    const h = await hub({ "a.md": "# A" });
    await withHub(h, async () => {
      const { data } = await h.send("private", {}, h.secrets.tracy);
      const vesper = await agent(h.b.port, h.secrets.vesper);
      try {
        const f = await vesper.call("chat_fetch");
        expect(f.isError).toBe(true);
        expect(String(f.data)).toContain("private");
        expect((await vesper.call("chat_post", { thread: data.thread.id, body: "let me in" })).isError).toBe(true);
      } finally {
        await vesper.close();
      }
      expect(h.chat.getThread(data.thread.id).messages).toHaveLength(1);
      expect(h.chat.getThread(data.thread.id).messages[0].state).toBe("queued"); // nothing was delivered to the outsider
      // Cori's key is revoked and a new one issued under the same name: no inherited access
      h.keys.revoke("cori");
      const again = h.keys.add("cori", "agent");
      const imposter = await agent(h.b.port, again);
      try {
        expect((await imposter.call("chat_fetch")).isError).toBe(true);
      } finally {
        await imposter.close();
      }
      // a stdio connection has no key, so no chat tools exist there
      const { server } = createServer(h.vault);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "cori-stdio", version: "1" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      expect((await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("chat_"))).toEqual([]);
    });
  });
  it("only the owner uses the pane: other person keys, read-only keys and agent keys are turned away", async () => {
    const h = await hub({ "a.md": "# A" });
    await withHub(h, async () => {
      const graph = (token: string) => h.req("/api/graph", { token }).then((r) => r.data);
      expect((await graph(h.secrets.tracy)).canChat).toBe(true);
      expect((await graph(LOCAL)).canChat).toBe(true); // the Helix on this computer
      for (const k of [h.secrets.office, h.secrets.viewer]) {
        expect((await graph(k)).canChat).toBe(false);
        expect((await graph(k)).chatOff).toBe("not-owner");
        expect((await h.req("/api/chat", { token: k })).status).toBe(403);
        expect((await h.send("hi", {}, k)).status).toBe(403);
        expect((await h.req("/api/version", { token: k })).data.chat).toBe(""); // not even a hint of activity
      }
      expect((await h.req("/api/chat", { token: h.secrets.cori })).status).toBe(401); // an agent key never reaches the Helix API
      expect(h.chat.listThreads()).toEqual([]);
      // delete is the owner's, and only theirs
      const t = (await h.send("bye", {}, h.secrets.tracy)).data.thread.id;
      expect((await h.req(`/api/chat/threads/${t}`, { method: "DELETE", token: h.secrets.office })).status).toBe(403);
      expect((await h.req(`/api/chat/threads/${t}`, { method: "DELETE", token: h.secrets.tracy })).status).toBe(200);
      expect(h.chat.listThreads()).toEqual([]);
    });
  });
  it("without a person key named for chat, only the Helix on this computer can use it", async () => {
    const h = await hub({}, { seat: false });
    await withHub(h, async () => {
      expect((await h.req("/api/graph", { token: h.secrets.tracy })).data.canChat).toBe(false);
      expect((await h.send("hi", {}, h.secrets.tracy)).status).toBe(403);
      expect((await h.send("hi")).status).toBe(200); // the local session
      const cori = await agent(h.b.port, h.secrets.cori);
      try {
        expect((await cori.call("chat_fetch")).isError).toBe(true); // no agent seated yet
      } finally {
        await cori.close();
      }
    });
  });
  it("--read-only: no chat for anyone, and no chat tools", async () => {
    const h = await hub({ "a.md": "# A" }, { readOnly: true });
    await withHub(h, async () => {
      const g = (await h.req("/api/graph", { token: h.secrets.tracy })).data;
      expect([g.canChat, g.chatOff]).toEqual([false, "read-only"]);
      expect((await h.send("hi", {}, h.secrets.tracy)).status).toBe(403);
      expect((await h.send("hi")).status).toBe(403);
      const cori = await agent(h.b.port, h.secrets.cori);
      try {
        expect((await cori.client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("chat_"))).toEqual([]);
      } finally {
        await cori.close();
      }
    });
  });
  it("chatting never touches the vault: same notes, same search, nothing written; Save to vault adds exactly one note, owner-authored", async () => {
    const h = await hub({ "a.md": "# Alpha\nfirst", "b.md": "# Beta\nsecond [[a]]" });
    await withHub(h, async () => {
      const before = listing(h.root);
      const search = async () => (await h.req("/api/graph", { token: h.secrets.tracy })).data.nodes.map((n: any) => n.path).sort();
      const nodes = await search();
      const cori = await agent(h.b.port, h.secrets.cori);
      try {
        for (let i = 0; i < 25; i++) {
          const r = await h.send(`question ${i} about alpha and beta`, { open: "a.md" }, h.secrets.tracy);
          if (i % 5 === 0) {
            await cori.call("chat_fetch", { limit: 20 });
            await cori.call("chat_post", { thread: r.data.thread.id, body: `answer ${i}`, cites: ["b.md"] });
          }
        }
        expect(listing(h.root)).toEqual(before);
        expect(await search()).toEqual(nodes);
        expect((await cori.call("search_notes", { query: "question" })).data).toEqual([]); // transcripts are not searchable
        expect((await cori.call("list_notes")).data.notes).toHaveLength(2);
        // Save to vault: the owner's own note write, through the normal endpoint, under their key
        const save = await h.req("/api/note", { method: "PUT", token: h.secrets.tracy, body: { path: "Chats/Cabin chat 2026-11-03.md", content: "# Chat: cabin\n\n**Me:** hi\n", base: null } });
        expect(save.status).toBe(200);
        expect(await search()).toEqual([...nodes, "Chats/Cabin chat 2026-11-03.md"].sort());
        const log = fs.readFileSync(path.join(h.root, ".mnemo/logs/mnemo.log"), "utf8").split("\n").filter((l) => l.includes('"owner-write"')).map((l) => JSON.parse(l));
        expect(log.map((l) => [l.path, l.actor])).toEqual([["Chats/Cabin chat 2026-11-03.md", "person:tracy"]]);
      } finally {
        await cori.close();
      }
    });
  });
  it("a reply can carry one proposal: it goes through the gate, approving writes it, rejecting writes nothing", async () => {
    const h = await hub({ "a.md": "# A" });
    await withHub(h, async () => {
      const { data } = await h.send("please draft a summary note", {}, h.secrets.tracy);
      const tid = data.thread.id;
      const cori = await agent(h.b.port, h.secrets.cori);
      const vesper = await agent(h.b.port, h.secrets.vesper);
      try {
        await cori.call("chat_fetch");
        const p1 = (await cori.call("write_note", { path: "Summary.md", content: "# Summary\nbody\n" })).data;
        expect(fs.existsSync(path.join(h.root, "Summary.md"))).toBe(false);
        // can't attach someone else's proposal, a made-up one, or the same one twice
        const theirs = (await vesper.call("write_note", { path: "Theirs.md", content: "x" })).data;
        expect((await cori.call("chat_post", { thread: tid, body: "x", proposal: theirs.id })).isError).toBe(true);
        expect((await cori.call("chat_post", { thread: tid, body: "x", proposal: "20260101000000-abcdef" })).isError).toBe(true);
        expect((await cori.call("chat_post", { thread: tid, body: "Here's a draft.", proposal: p1.id })).isError).toBe(false);
        expect((await cori.call("chat_post", { thread: tid, body: "again", proposal: p1.id })).isError).toBe(true);
        const pane = (await h.req(`/api/chat/threads/${tid}`, { token: h.secrets.tracy })).data;
        expect(pane.thread.messages[1].proposal).toBe(p1.id);
        expect(pane.proposals[p1.id]).toMatchObject({ status: "pending", op: "write", path: "Summary.md", exists: false });
        expect(fs.existsSync(path.join(h.root, "Summary.md"))).toBe(false); // still nothing written
        // approve through the ordinary approval API
        expect((await h.req(`/api/proposals/${p1.id}/approve`, { method: "POST", token: h.secrets.tracy })).status).toBe(200);
        expect(fs.readFileSync(path.join(h.root, "Summary.md"), "utf8")).toBe("# Summary\nbody\n");
        expect((await h.req(`/api/chat/threads/${tid}`, { token: h.secrets.tracy })).data.proposals[p1.id].status).toBe("approved");
        // a second one, rejected: nothing lands
        const p2 = (await cori.call("write_note", { path: "Nope.md", content: "n" })).data;
        await cori.call("chat_post", { thread: tid, body: "Or this?", proposal: p2.id });
        expect((await h.req(`/api/proposals/${p2.id}/reject`, { method: "POST", token: h.secrets.tracy })).status).toBe(200);
        expect(fs.existsSync(path.join(h.root, "Nope.md"))).toBe(false);
      } finally {
        await cori.close();
        await vesper.close();
      }
    });
  });
  it("bad input is refused cleanly", async () => {
    const h = await hub({});
    await withHub(h, async () => {
      expect((await h.send("   ", {}, h.secrets.tracy)).status).toBe(400);
      expect((await h.send("x".repeat(MAX_BODY_CHARS + 1), {}, h.secrets.tracy)).status).toBe(400);
      expect((await h.send("hi", { thread: "../../x" }, h.secrets.tracy)).status).toBe(400);
      expect((await h.send("hi", { thread: "20260101000000-abcdef" }, h.secrets.tracy)).status).toBe(400); // no such conversation
      expect((await h.req("/api/chat/messages", { method: "POST", token: h.secrets.tracy, body: { body: 5 } })).status).toBe(400);
      expect((await h.req("/api/chat/threads/zzz", { token: h.secrets.tracy })).status).toBe(404);
      expect(h.chat.listThreads()).toEqual([]);
    });
  });
});
