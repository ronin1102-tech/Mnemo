import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge.js";
import { ProposalStore } from "../src/proposals.js";
import { TokenStore } from "../src/tokens.js";
import { Vault } from "../src/vault.js";
import { describe, expect, it } from "./expect.js";
import { tmpVault } from "./helpers.js";

const TOKEN = "test-token-0123456789";

function uiDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ui-"));
  for (const f of ["index.html", "app.js", "style.css"]) fs.writeFileSync(path.join(d, f), "x");
  return d;
}

async function owner(files: Record<string, string>, readOnly = false) {
  const root = tmpVault(files);
  const vault = new Vault(root);
  const b = await startBridge(vault, { port: 0, uiDir: uiDir(), mcp: true, readOnly, token: TOKEN });
  const req = (p: string, o: { method?: string; body?: unknown; token?: string } = {}) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port: b.port, path: p, method: o.method ?? "GET", headers: { Host: `127.0.0.1:${b.port}`, "X-Mnemo-Token": o.token ?? TOKEN, "Content-Type": "application/json" } },
        (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve({ status: res.statusCode!, data: s ? JSON.parse(s) : null }));
        },
      );
      r.on("error", reject);
      r.end(o.body === undefined ? undefined : JSON.stringify(o.body));
    });
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const save = (p: string, content: string, base: string | null, token?: string) => req("/api/note", { method: "PUT", body: { path: p, content, base }, token });
  const hashOf = async (p: string) => (await req("/api/note?path=" + encodeURIComponent(p))).data.hash as string;
  return { root, vault, b, req, read, save, hashOf, store: new ProposalStore(vault), keys: new TokenStore(vault) };
}

async function agent(port: number, key: string) {
  const client = new Client({ name: "office-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let data: any = r.content[0].text;
    try { data = JSON.parse(data); } catch { /* text */ }
    return { isError: !!r.isError, data, close: () => client.close() };
  };
}

describe("owner writes: the owner's own pen, not a proposal", () => {
  it("creates and edits notes byte-for-byte, atomically, and the index sees them at once", async () => {
    const { b, req, read, save, hashOf, root } = await owner({ "a.md": "# A\nold\n" });
    const typed = "---\ntitle: Kept as typed\nmood: unparsed but preserved\n---\n# B\nnew  note\twith tabs\r\nand CRLF ✓\n";
    const c = await save("ideas/b.md", typed, null);
    expect(c.status).toBe(200);
    expect(c.data.created).toBe(true);
    expect(read("ideas/b.md")).toBe(typed);
    const g = (await req("/api/graph")).data;
    expect(g.canWrite).toBe(true);
    expect(g.nodes.map((n: { path: string }) => n.path)).toContain("ideas/b.md");
    const e = await save("a.md", "# A\nedited\n", await hashOf("a.md"));
    expect(e.status).toBe(200);
    expect(read("a.md")).toBe("# A\nedited\n");
    expect(fs.readdirSync(root).filter((f) => f.includes("mnemo-tmp"))).toEqual([]);
    const log = fs.readFileSync(path.join(root, ".mnemo/logs/mnemo.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "owner-write");
    expect(log.map((l) => [l.action, l.path])).toEqual([["create", "ideas/b.md"], ["edit", "a.md"]]);
    expect(log[0].by.actor).toBe("helix");
    await b.close();
  });
  it("never silently overwrites: a stale base, or an existing name on create, is a 409 with the disk version", async () => {
    const { b, read, save, hashOf, root } = await owner({ "a.md": "v1" });
    const base = await hashOf("a.md");
    fs.writeFileSync(path.join(root, "a.md"), "v2 from another editor");
    const r = await save("a.md", "mine", base);
    expect(r.status).toBe(409);
    expect(r.data.current).toBe("v2 from another editor");
    expect(read("a.md")).toBe("v2 from another editor");
    // the owner chooses to keep theirs: resend against the version they were shown
    expect((await save("a.md", "mine", r.data.hash)).status).toBe(200);
    expect(read("a.md")).toBe("mine");
    expect((await save("a.md", "x", null)).status).toBe(409);
    await b.close();
  });
  it("an agent proposal on a note the owner then edits goes stale on settle; the owner's bytes stay", async () => {
    const { b, read, save, hashOf, store } = await owner({ "a.md": "original" });
    const p = store.proposeWrite("a.md", "agent version", "agent-x");
    await save("a.md", "owner version", await hashOf("a.md"));
    expect(() => store.approve(p.id)).toThrow(/stale/);
    expect(store.get(p.id).status).toBe("stale");
    expect(read("a.md")).toBe("owner version");
    await b.close();
  });
  it("person keys write too (from any allowed address), each write logged with the key's name", async () => {
    const { b, req, save, keys, read, root, store } = await owner({ "a.md": "x" });
    const k = keys.add("tracy", "person");
    expect((await req("/api/graph", { token: k })).data.canWrite).toBe(true);
    const typed = "# From my phone\nbyte ✓ for\tbyte\r\n";
    expect((await save("Phone/idea.md", typed, null, k)).status).toBe(200);
    expect(read("Phone/idea.md")).toBe(typed);
    const h = (await req("/api/note?path=Phone%2Fidea.md", { token: k })).data.hash;
    expect((await save("Phone/idea.md", "edited\n", h, k)).status).toBe(200);
    expect(read("Phone/idea.md")).toBe("edited\n");
    expect((await save("Phone/idea.md", "stale\n", h, k)).status).toBe(409);
    expect((await save("a.md", "over", null, k)).status).toBe(409);
    expect(read("a.md")).toBe("x");
    // a request from the phone is the owner's own; agents still can't touch it, only answer it
    expect((await save("Requests/from phone.md", "# Do a thing\n", null, k)).status).toBe(200);
    expect(() => store.proposeWrite("Requests/from phone.md", "hijack", "agent-x")).toThrow(/owner's requests/);
    store.proposeWrite("Answer.md", "# Answer\n", "agent-x", "Requests/from phone.md");
    expect((await req("/api/graph", { token: k })).data.requests[0].status).toBe("in-progress");
    expect(read("Requests/from phone.md")).toBe("# Do a thing\n");
    const log = fs.readFileSync(path.join(root, ".mnemo/logs/mnemo.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "owner-write");
    expect(log.map((l) => [l.action, l.path, l.actor, l.by.user])).toEqual([
      ["create", "Phone/idea.md", "person:tracy", "tracy"],
      ["edit", "Phone/idea.md", "person:tracy", "tracy"],
      ["create", "Requests/from phone.md", "person:tracy", "tracy"],
    ]);
    // revoking the key ends writing with everything else
    keys.revoke("tracy");
    expect((await save("Phone/late.md", "x", null, k)).status).toBe(401);
    expect(fs.existsSync(path.join(root, "Phone/late.md"))).toBe(false);
    await b.close();
  });
  it("agent keys, read-only keys, --read-only mode and bad paths never write", async () => {
    const { b, req, save, keys, read, root } = await owner({ "a.md": "x" });
    const agentKey = keys.add("office-pc", "agent");
    const viewer = keys.add("intern", "person", true);
    expect((await save("a.md", "agent", null, agentKey)).status).toBe(401);
    expect((await req("/api/proposals/20260101000000-abcdef/approve", { method: "POST", token: agentKey })).status).toBe(401);
    expect((await req("/api/graph", { token: viewer })).data.canWrite).toBe(false);
    expect((await save("v.md", "x", null, viewer)).status).toBe(403);
    for (const bad of ["../out.md", ".mnemo/x.md", ".hidden/x.md", "x.txt", "/etc/x.md"]) expect((await save(bad, "x", null)).status).toBe(400);
    expect(read("a.md")).toBe("x");
    expect(fs.readdirSync(root).sort()).toEqual([".mnemo", "a.md"]);
    await b.close();
    const ro = await owner({ "a.md": "x" }, true);
    const k = ro.keys.add("tracy", "person");
    for (const token of [undefined, k]) {
      expect((await ro.req("/api/graph", { token })).data.canWrite).toBe(false);
      expect((await ro.save("a.md", "y", await ro.hashOf("a.md"), token)).status).toBe(403);
    }
    expect(ro.read("a.md")).toBe("x");
    await ro.b.close();
  });
});

describe("owner requests: the crew's inbox", () => {
  it("agents read requests, can't change them, answer them through the gate, and the status follows", async () => {
    const { b, save, keys, store, read, req, root } = await owner({ "Projects/plan.md": "# Plan\nSee [[ask]]" });
    const request = "# Summarise the plan\nPlease write a one-paragraph summary as a new note.\n";
    await save("Requests/ask.md", request, null);
    const call = await agent(b.port, keys.add("office-pc", "agent"));

    const listed = (await call("list_requests")).data;
    expect(listed).toEqual([{ path: "Requests/ask.md", title: "Summarise the plan", created: null, status: "open", answers: [] }]);
    expect((await call("read_note", { path: "Requests/ask.md" })).data.content).toBe(request);

    // no agent tool can touch Requests/ (any case), not even through a move or its link rewrites
    for (const [tool, args] of [
      ["write_note", { path: "Requests/ask.md", content: "hijacked" }],
      ["write_note", { path: "requests/new.md", content: "x" }],
      ["append_note", { path: "Requests/ask.md", content: "x" }],
      ["patch_note", { path: "Requests/ask.md", anchor: "Please", replacement: "Don't" }],
      ["delete_note", { path: "Requests/ask.md" }],
      ["move_note", { from: "Requests/ask.md", to: "elsewhere.md" }],
      ["move_note", { from: "Projects/plan.md", to: "Requests/plan.md" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(String(r.data)).toContain("owner's requests");
    }
    const mv = store.proposeMove("Projects/plan.md", "Archive/plan.md", "agent-x");
    expect(mv.changes.map((c) => c.path)).toEqual(["Projects/plan.md"]);
    store.reject(mv.id);

    // the answer: an ordinary proposal naming the request
    const bad = await call("write_note", { path: "Summary.md", content: "x", request: "Projects/plan.md" });
    expect(bad.isError).toBe(true);
    const ans = (await call("write_note", { path: "Summary.md", content: "# Summary\nShort.", request: "Requests/ask.md" })).data;
    expect(ans.request).toBe("Requests/ask.md");
    expect(fs.existsSync(path.join(root, "Summary.md"))).toBe(false);
    expect((await call("list_requests")).data[0].status).toBe("in-progress");
    const g = (await req("/api/graph")).data;
    expect(g.proposals[0].request).toBe("Requests/ask.md");
    expect(g.requests[0].status).toBe("in-progress");

    store.approve(ans.id);
    const done = (await call("list_requests", { status: "addressed" })).data;
    expect(done[0].answers.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([[ans.id, "approved"]]);
    expect(read("Requests/ask.md")).toBe(request); // the request file itself is never rewritten

    // the owner closes it by marking it done
    await save("Requests/ask.md", "---\nstatus: done\n---\n" + request, (await req("/api/note?path=Requests%2Fask.md")).data.hash);
    expect((await call("list_requests")).data[0].status).toBe("closed");
    await b.close();
  });
});
