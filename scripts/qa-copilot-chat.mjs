#!/usr/bin/env node
// Mnemo Copilot chat QA. Runs on a THROWAWAY vault in the temp folder (never ~/Mnemo-Vault), with its own
// hub on its own port, and a real MCP client (over HTTP, with an agent key) standing in for the agent.
//   node scripts/qa-copilot-chat.mjs            (Node 20; the repo must be built: npm run build)
// Prints PASS/FAIL per check; exits non-zero on any FAIL. The phone proof and the Catalina look are manual.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(ROOT, "packages/mnemo-mcp");
const PORT = Number(process.env.PORT || 7392);
const V = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-chat-qa-"));
const sdk = (p) => import(pathToFileURL(path.join(MCP, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS  " : "FAIL  ") + name + (!cond && extra ? `  (${extra})` : "")); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (...a) => execFileSync(process.execPath, [path.join(MCP, "dist/ctl.js"), "--vault", V, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (rel) => fs.readFileSync(path.join(V, rel), "utf8");
const notes = () => { const out = []; const walk = (d, p) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const r = p ? `${p}/${e.name}` : e.name; e.isDirectory() ? walk(path.join(d, e.name), r) : out.push(r + ":" + fs.readFileSync(path.join(d, e.name), "utf8")); } }; walk(V, ""); return out.sort(); };

let hub;
async function startHub(...extra) {
  hub = spawn(process.execPath, [path.join(MCP, "dist/ctl.js"), "--vault", V, ...extra, "hub", "--port", String(PORT), "--no-open"], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); return; } catch { await sleep(250); } }
  throw new Error("the hub did not start");
}
async function stopHub() { hub.kill(); await new Promise((r) => hub.once("exit", r)); await sleep(300); }
const api = async (p, key, o = {}) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: o.method || "GET", headers: { "X-Mnemo-Token": key, "Content-Type": "application/json" }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); let data = null; try { data = await r.json(); } catch {} return { status: r.status, data }; };
const agent = async (key) => { const c = new Client({ name: "qa-agent", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })); const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); let d = r.content[0].text; try { d = JSON.parse(d); } catch {} return { isError: !!r.isError, data: d }; }; return { c, call }; };

console.log(`Mnemo Copilot chat QA · ${process.version} · vault ${V} · port ${PORT}`);
fs.mkdirSync(path.join(V, "Trips"));
fs.writeFileSync(path.join(V, "Trips/Cabin.md"), "# Cabin\nBook the lakeside cabin in June.\n");
fs.writeFileSync(path.join(V, "hello.md"), "# Hello\nMnemo is connected.\n");
const TRACY = ctl("token", "add", "qa-owner", "--person"), CORI = ctl("token", "add", "qa-cori", "--agent");
const OTHER = ctl("token", "add", "qa-other-agent", "--agent"), OFFICE = ctl("token", "add", "qa-office", "--person");
const VIEWER = ctl("token", "add", "qa-viewer", "--person", "--read-only");
ctl("chat", "setup", "qa-owner", "qa-cori");
check("chat setup names exactly an owner and an agent", /owner:\s+qa-owner/.test(ctl("chat", "status")) && /agent:\s+qa-cori/.test(ctl("chat", "status")));
await startHub();
const before = notes();
try {
  // 1. a message persists across a hub restart, queued
  const sent = await api("/api/chat/messages", TRACY, { method: "POST", body: { body: "When should I book the lakeside cabin?", open: "hello.md" } });
  const tid = sent.data.thread.id;
  check("1 owner message is stored as queued", sent.status === 200 && sent.data.message.state === "queued");
  await stopHub(); await startHub();
  const list = await api("/api/chat", TRACY);
  check("1 still queued after a hub restart", list.data.queued === 1 && list.data.threads[0].id === tid);
  check("1 the message is not in the vault directory", !fs.readdirSync(V).some((f) => /chat/i.test(f)) && fs.existsSync(path.join(V, ".mnemo/chat")));

  // 2. the agent's next session: tools appear with no agent-side change; fetch delivers
  const cori = await agent(CORI);
  const tools = (await cori.c.listTools()).tools.map((t) => t.name);
  check("2 the tool list shows chat_fetch and chat_post", tools.includes("chat_fetch") && tools.includes("chat_post"));
  const got = (await cori.call("chat_fetch")).data;
  check("2 chat_fetch returns the message", got.messages.length === 1 && got.messages[0].body.startsWith("When should I book"));
  check("2 …and marks it delivered", (await api(`/api/chat/threads/${tid}`, TRACY)).data.thread.messages[0].state === "delivered" && (await cori.call("chat_fetch")).data.messages.length === 0);
  // 7. chips == what the fetch attached
  const chips = sent.data.message.context.map((c) => `${c.path}|${c.title}|${c.why}`).sort();
  const fetched = got.messages[0].context.map((c) => `${c.path}|${c.title}|${c.why}`).sort();
  check("7 chips list exactly the notes the fetch attached", chips.length > 0 && JSON.stringify(chips) === JSON.stringify(fetched), `${chips} vs ${fetched}`);

  // 3. a reply, with a citation
  const post = await cori.call("chat_post", { thread: tid, body: "Book in **June**.", cites: ["Trips/Cabin.md"] });
  const t1 = (await api(`/api/chat/threads/${tid}`, TRACY)).data.thread;
  check("3 chat_post lands, labelled as the agent, with a cited note", !post.isError && t1.messages[1].author === "agent" && t1.messages[1].cites[0].title === "Cabin");
  check("3 the owner's message is now answered", t1.messages[0].state === "answered");

  // 4. a proposal on a reply goes through the gate
  const p1 = (await cori.call("write_note", { path: "Plan.md", content: "# Plan\nbody\n" })).data;
  await cori.call("chat_post", { thread: tid, body: "Here is a draft.", proposal: p1.id });
  const pane = (await api(`/api/chat/threads/${tid}`, TRACY)).data;
  check("4 the reply carries the proposal, pending", pane.proposals[p1.id].status === "pending" && !fs.existsSync(path.join(V, "Plan.md")));
  check("4 approving writes the note", (await api(`/api/proposals/${p1.id}/approve`, TRACY, { method: "POST" })).status === 200 && read("Plan.md") === "# Plan\nbody\n");
  const p2 = (await cori.call("write_note", { path: "Nope.md", content: "n" })).data;
  await cori.call("chat_post", { thread: tid, body: "Or this?", proposal: p2.id });
  await api(`/api/proposals/${p2.id}/reject`, TRACY, { method: "POST" });
  check("4 rejecting writes nothing", !fs.existsSync(path.join(V, "Nope.md")));
  const theirs = (await (await agent(OTHER)).call("write_note", { path: "Theirs.md", content: "x" })).data;
  check("4 the agent cannot attach a proposal that isn't its own", (await cori.call("chat_post", { thread: tid, body: "x", proposal: theirs.id })).isError);
  check("4 …nor the same proposal twice", (await cori.call("chat_post", { thread: tid, body: "again", proposal: p1.id })).isError);

  // 5. chatting leaves the vault alone; Save to vault adds exactly one owner-authored note
  const afterChat = notes();
  const beforeSet = new Set(before.filter((n) => !n.startsWith("Plan.md")));
  for (let i = 0; i < 20; i++) await api("/api/chat/messages", TRACY, { method: "POST", body: { body: `filler question ${i} about the cabin` } });
  const nowNotes = notes();
  check("5 twenty more messages changed no note", JSON.stringify(nowNotes) === JSON.stringify(afterChat) && [...beforeSet].every((n) => nowNotes.includes(n)));
  check("5 chat text is not searchable", (await cori.call("search_notes", { query: "filler" })).data.length === 0);
  const save = await api("/api/note", TRACY, { method: "PUT", body: { path: "Chats/QA chat.md", content: "# Chat: QA\n\n**Me:** hi\n", base: null } });
  const logs = fs.readFileSync(path.join(V, ".mnemo/logs/mnemo.log"), "utf8").split("\n").filter((l) => l.includes('"owner-write"')).map((l) => JSON.parse(l));
  check("5 Save to vault creates exactly one note, owner-authored", save.status === 200 && notes().length === nowNotes.length + 1 && logs.length === 1 && logs[0].actor === "person:qa-owner");

  // 6. nobody else is in the channel
  const other = await agent(OTHER);
  const f = await other.call("chat_fetch");
  check("6 another agent key calling chat_fetch is refused", f.isError);
  check("6 …and chat_post is refused", (await other.call("chat_post", { thread: tid, body: "let me in" })).isError);
  check("6 an office person key gets 403 on chat", (await api("/api/chat", OFFICE)).status === 403 && (await api("/api/chat", VIEWER)).status === 403);
  check("6 an agent key is refused by the Helix API (401)", (await api("/api/chat", CORI)).status === 401);
  ctl("token", "revoke", "qa-cori"); const reissued = ctl("token", "add", "qa-cori", "--agent");
  check("6 a re-issued key with the same name inherits nothing", (await (await agent(reissued)).call("chat_fetch")).isError);
  const stdio = new Client({ name: "stdio-agent", version: "1" });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(MCP, "dist/cli.js"), "--vault", V, "serve"] }));
  check("6 a stdio connection has no chat tools at all", !(await stdio.listTools()).tools.some((t) => t.name.startsWith("chat_")));
  await stdio.close();

  // delete is the owner's
  check("owner can delete a conversation; others cannot", (await api(`/api/chat/threads/${tid}`, OFFICE, { method: "DELETE" })).status === 403 && (await api(`/api/chat/threads/${tid}`, TRACY, { method: "DELETE" })).status === 200);

  // --read-only: no chat for anyone
  await stopHub(); await startHub("--read-only");
  const g = await api("/api/graph", TRACY);
  check("--read-only: chat is off, even for the owner", g.data.canChat === false && (await api("/api/chat/messages", TRACY, { method: "POST", body: { body: "hi" } })).status === 403);
  check("--read-only: no chat tools", !(await (await agent(reissued)).c.listTools()).tools.some((t) => t.name.startsWith("chat_")));
} finally {
  hub.kill();
}
console.log("----");
console.log(`${pass} passed, ${fail} failed`);
fs.rmSync(V, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
