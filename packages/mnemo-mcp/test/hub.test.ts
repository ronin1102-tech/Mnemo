import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isAllowedBind, startBridge } from "../src/bridge.js";
import { ProposalStore } from "../src/proposals.js";
import { TokenStore } from "../src/tokens.js";
import { Vault } from "../src/vault.js";
import { describe, expect, it } from "./expect.js";
import { tmpVault } from "./helpers.js";

function uiDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ui-"));
  for (const f of ["index.html", "app.js", "style.css"]) fs.writeFileSync(path.join(d, f), "x");
  return d;
}

async function hub(files: Record<string, string>, opts: { readOnly?: boolean; allowHosts?: string[] } = {}) {
  const root = tmpVault(files);
  const vault = new Vault(root);
  const keys = new TokenStore(vault);
  const b = await startBridge(vault, { port: 0, uiDir: uiDir(), mcp: true, ...opts });
  return { root, vault, keys, b, store: new ProposalStore(vault) };
}

async function agent(port: number, key?: string, host = "127.0.0.1") {
  const client = new Client({ name: "office-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), {
    requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let data: unknown = r.content[0].text;
    try {
      data = JSON.parse(r.content[0].text);
    } catch {
      /* text */
    }
    return { isError: !!r.isError, data };
  };
  return { client, call };
}

function raw(port: number, p: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

describe("access keys", () => {
  it("issue, verify, revoke; only hashes are stored, and the file is private", () => {
    const vault = new Vault(tmpVault({}));
    const keys = new TokenStore(vault);
    const k = keys.add("office-thinkcentre", "agent");
    expect(k.startsWith("mn_a_")).toBe(true);
    expect(keys.verify(k)?.name).toBe("office-thinkcentre");
    expect(keys.verify(k + "x")).toBe(null);
    expect(keys.verify(undefined)).toBe(null);
    const file = fs.readFileSync(path.join(vault.stateDir, "tokens.json"), "utf8");
    expect(file).not.toContain(k);
    if (process.platform !== "win32") expect(fs.statSync(path.join(vault.stateDir, "tokens.json")).mode & 0o077).toBe(0);
    expect(() => keys.add("office-thinkcentre", "agent")).toThrow(/already exists/);
    expect(() => keys.add("Bad Name!", "agent")).toThrow();
    expect(keys.revoke("office-thinkcentre")).toBe(true);
    expect(keys.verify(k)).toBe(null);
  });
  it("agents can never read the key file through the vault", async () => {
    const { b, keys } = await hub({ "a.md": "x" });
    const a = await agent(b.port, keys.add("pc", "agent"));
    expect((await a.call("read_note", { path: ".mnemo/tokens.json" })).isError).toBe(true);
    await a.client.close();
    await b.close();
  });
});

describe("hub: listening only where it should", () => {
  it("binds only loopback and Tailscale addresses", () => {
    for (const ok of ["127.0.0.1", "100.103.16.78", "100.64.0.1", "100.127.255.254", "::1", "fd7a:115c:a1e0::ab01:10ca"]) expect(isAllowedBind(ok), ok).toBe(true);
    for (const bad of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "100.63.0.1", "100.128.0.1", "8.8.8.8", "fe80::1", "localhost", "onemoreizzysmbp.tail81e3a6.ts.net"]) expect(isAllowedBind(bad), bad).toBe(false);
  });
  it("refuses to start on a non-tailnet address", async () => {
    const vault = new Vault(tmpVault({}));
    let threw = false;
    try {
      await startBridge(vault, { port: 0, uiDir: uiDir(), mcp: true, bind: ["0.0.0.0"] });
    } catch (e) {
      threw = /Refusing to listen/.test(String(e));
    }
    expect(threw).toBe(true);
  });
  it("accepts an allowed MagicDNS host name, still refuses others", async () => {
    const { b, keys } = await hub({ "a.md": "x" }, { allowHosts: ["onemoreizzysmbp.tail81e3a6.ts.net"] });
    const k = keys.add("pc", "agent");
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    const h = { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    expect((await raw(b.port, "/mcp", { ...h, Host: "onemoreizzysmbp.tail81e3a6.ts.net" }, "POST", init)).status).toBe(200);
    expect((await raw(b.port, "/mcp", { ...h, Host: "evil.example" }, "POST", init)).status).toBe(403);
    await b.close();
  });
});

describe("hub: MCP over HTTP for agents on other machines", () => {
  it("needs an agent key: none, wrong, revoked and person keys are all refused", async () => {
    const { b, keys } = await hub({ "a.md": "x" });
    const person = keys.add("tracy", "person");
    const gone = keys.add("old-pc", "agent");
    keys.revoke("old-pc");
    for (const k of [undefined, "mn_a_wrong", gone, person]) {
      let refused = false;
      try {
        await agent(b.port, k);
      } catch {
        refused = true;
      }
      expect(refused, String(k).slice(0, 8)).toBe(true);
    }
    await b.close();
  });
  it("same tools as stdio; proposals are recorded under the key's name, never written", async () => {
    const { root, b, keys, store } = await hub({ "Mnemo.md": "# Mnemo\nsecond brain [[Helix]]", "Helix.md": "# Helix" });
    const a = await agent(b.port, keys.add("office-thinkcentre", "agent"));
    const names = (await a.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_notes");
    expect(names).toContain("write_note");
    expect(((await a.call("search_notes", { query: "brain" })).data as { path: string }[])[0].path).toBe("Mnemo.md");
    const r = await a.call("append_note", { path: "Helix.md", content: "from the office" });
    expect((r.data as { status: string }).status).toBe("pending");
    expect(fs.readFileSync(path.join(root, "Helix.md"), "utf8")).toBe("# Helix");
    const p = store.list("pending")[0];
    expect(p.client).toBe("office-thinkcentre (office-agent)");
    await a.client.close();
    await b.close();
  });
  it("a read-only agent key gets no write tools", async () => {
    const { b, keys } = await hub({ "a.md": "x" });
    const a = await agent(b.port, keys.add("viewer-pc", "agent", true));
    const names = (await a.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /write|append|patch|move|delete/.test(n))).toEqual([]);
    await a.client.close();
    await b.close();
  });
  it("an agent key can never reach the approval API", async () => {
    const { b, keys, store } = await hub({ "a.md": "x" });
    const k = keys.add("pc", "agent");
    const p = store.proposeWrite("a.md", "y", "pc");
    expect((await raw(b.port, `/api/proposals/${p.id}/approve`, { "X-Mnemo-Token": k }, "POST")).status).toBe(401);
    expect((await raw(b.port, `/api/graph`, { Authorization: `Bearer ${k}` })).status).toBe(401);
    expect(store.get(p.id).status).toBe("pending");
    await b.close();
  });
  it("an MCP session can't be used with a different key", async () => {
    const { b, keys } = await hub({ "a.md": "x" });
    const k1 = keys.add("pc-one", "agent");
    const k2 = keys.add("pc-two", "agent");
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: b.port, path: "/mcp", method: "POST", headers: { ...h, Host: `127.0.0.1:${b.port}`, Authorization: `Bearer ${k1}` } }, resolve);
      r.end(init);
    });
    res.resume();
    const sid = String(res.headers["mcp-session-id"]);
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await raw(b.port, "/mcp", { ...h, Authorization: `Bearer ${k2}`, "mcp-session-id": sid }, "POST", list)).status).toBe(403);
    await b.close();
  });
  it("oversized MCP requests get a clean 413, and the hub keeps serving", async () => {
    const { b, keys } = await hub({ "a.md": "x" });
    const k = keys.add("pc", "agent");
    const big = "x".repeat(65 * 1024 * 1024);
    const r = await raw(b.port, "/mcp", { Authorization: `Bearer ${k}`, "Content-Type": "application/json", "Content-Length": String(big.length) }, "POST", big);
    expect(r.status).toBe(413);
    const a = await agent(b.port, k);
    expect((await a.call("read_note", { path: "a.md" })).isError).toBe(false);
    await a.client.close();
    await b.close();
  });
});

describe("hub: people on other machines", () => {
  it("a person key opens the Helix API and approvals are recorded under that person", async () => {
    const { root, b, keys, store } = await hub({ "a.md": "old" });
    const k = keys.add("tracy", "person");
    const p = store.proposeWrite("a.md", "new", "office-thinkcentre");
    const g = JSON.parse((await raw(b.port, "/api/graph", { "X-Mnemo-Token": k })).body);
    expect(g.viewer).toBe("tracy");
    const r = await raw(b.port, `/api/proposals/${p.id}/approve`, { "X-Mnemo-Token": k }, "POST");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).settledBy).toEqual({ actor: "helix", user: "tracy" });
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("new");
    await b.close();
  });
  it("a read-only person key can look but not approve", async () => {
    const { b, keys, store } = await hub({ "a.md": "old" });
    const k = keys.add("intern", "person", true);
    const p = store.proposeWrite("a.md", "new", "pc");
    expect(JSON.parse((await raw(b.port, "/api/graph", { "X-Mnemo-Token": k })).body).readOnly).toBe(true);
    expect((await raw(b.port, `/api/proposals/${p.id}/approve`, { "X-Mnemo-Token": k }, "POST")).status).toBe(403);
    expect(store.get(p.id).status).toBe("pending");
    await b.close();
  });
  it("plain `ui` mode has no MCP endpoint", async () => {
    const vault = new Vault(tmpVault({}));
    const b = await startBridge(vault, { port: 0, uiDir: uiDir() });
    const k = new TokenStore(vault).add("pc", "agent");
    expect((await raw(b.port, "/mcp", { Authorization: `Bearer ${k}` }, "POST", "{}")).status).toBe(404);
    await b.close();
  });
});
