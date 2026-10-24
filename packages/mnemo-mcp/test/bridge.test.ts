import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startBridge } from "../src/bridge.js";
import { ProposalStore } from "../src/proposals.js";
import { Vault } from "../src/vault.js";
import { describe, expect, it } from "./expect.js";
import { tmpVault } from "./helpers.js";

function uiDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ui-"));
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>t</title>");
  fs.writeFileSync(path.join(d, "app.js"), "/* app */");
  fs.writeFileSync(path.join(d, "style.css"), "/* css */");
  fs.writeFileSync(path.join(d, "icon-32.png"), "png");
  return d;
}

/** Raw request, so tests can forge Host and Origin headers (fetch forbids setting Host). */
function req(port: number, p: string, o: { method?: string; token?: string; host?: string; origin?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}` };
    if (o.token !== undefined) headers["X-Mnemo-Token"] = o.token;
    if (o.origin) headers.Origin = o.origin;
    const r = http.request({ host: "127.0.0.1", port, path: p, method: o.method ?? "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function bridge(files: Record<string, string>, readOnly = false) {
  const root = tmpVault(files);
  const vault = new Vault(root);
  const b = await startBridge(vault, { port: 0, uiDir: uiDir(), readOnly, token: "test-token-0123456789" });
  return { root, vault, b, store: new ProposalStore(vault), api: (p: string, o: { method?: string } = {}) => req(b.port, p, { ...o, token: b.token }) };
}

describe("bridge: only this machine, only this page", () => {
  it("binds to loopback only", async () => {
    const { b } = await bridge({ "a.md": "# A" });
    expect((b.address as { address: string }).address).toBe("127.0.0.1");
    await b.close();
  });
  it("API refuses a missing or wrong token", async () => {
    const { b } = await bridge({ "a.md": "# A" });
    expect((await req(b.port, "/api/graph")).status).toBe(401);
    expect((await req(b.port, "/api/graph", { token: "test-token-012345678X" })).status).toBe(401);
    expect((await req(b.port, "/api/graph", { token: "short" })).status).toBe(401);
    await b.close();
  });
  it("refuses a foreign Host (DNS rebinding) even with the right token", async () => {
    const { b } = await bridge({ "a.md": "# A" });
    expect((await req(b.port, "/api/graph", { token: b.token, host: "evil.example:" + b.port })).status).toBe(403);
    expect((await req(b.port, "/", { host: "evil.example" })).status).toBe(403);
    await b.close();
  });
  it("refuses cross-origin requests and never sends CORS headers", async () => {
    const { b } = await bridge({ "a.md": "# A" });
    const r = await req(b.port, "/api/graph", { token: b.token, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const ok = await req(b.port, "/api/graph", { token: b.token, origin: `http://127.0.0.1:${b.port}` });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
    await b.close();
  });
  it("serves only the UI files: no traversal, strict security headers", async () => {
    const { b } = await bridge({ "a.md": "# A" });
    const page = await req(b.port, "/");
    expect(page.status).toBe(200);
    expect(String(page.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/a.md", "/.mnemo/index.db", "/etc/passwd"]) expect((await req(b.port, p)).status).toBe(404);
    const icon = await req(b.port, "/icon-32.png");
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    await b.close();
  });
});

describe("bridge: live data and the write gate", () => {
  it("serves the graph with pending proposals, including ones for notes that don't exist yet", async () => {
    const { b, store, api } = await bridge({ "a.md": "# A\n[[b]]", "b.md": "# B" });
    store.proposeWrite("new.md", "# New", "agent-x");
    store.proposeAppend("a.md", "more", "agent-y");
    const g = JSON.parse((await api("/api/graph")).body);
    expect(g.live).toBe(true);
    expect(g.nodes.map((n: { path: string }) => n.path).sort()).toEqual(["a.md", "b.md"]);
    expect(g.links).toEqual([{ src: "a.md", dst: "b.md" }]);
    const byPath = Object.fromEntries(g.proposals.map((p: { path: string; exists: boolean }) => [p.path, p.exists]));
    expect(byPath).toEqual({ "new.md": false, "a.md": true });
    await b.close();
  });
  it("serves one note's full text to the reader, through the vault jail", async () => {
    const { b, api } = await bridge({ "a.md": "# A\nfull body", "sub/b.md": "# B", ".hidden/c.md": "# C", "notes.txt": "x" });
    const r = await api("/api/note?path=" + encodeURIComponent("a.md"));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: "a.md", content: "# A\nfull body" });
    expect(JSON.parse((await api("/api/note?path=sub%2Fb.md")).body).content).toBe("# B");
    for (const bad of ["../x.md", "/etc/passwd", ".mnemo/tokens.json", ".mnemo/x.md", ".hidden/c.md", "notes.txt", "missing.md", ""]) {
      expect((await api("/api/note?path=" + encodeURIComponent(bad))).status, bad).toBe(400);
    }
    expect((await req(b.port, "/api/note?path=a.md")).status).toBe(401);
    await b.close();
  });
  it("approve in the UI lands byte-for-byte what was proposed, via the same writer", async () => {
    const { root, b, store, api } = await bridge({ "a.md": "line one\n" });
    const p = store.proposeAppend("a.md", "added by agent", "agent-x");
    const detail = JSON.parse((await api(`/api/proposals/${p.id}`)).body);
    expect(detail.diff).toContain("+ added by agent");
    const r = await api(`/api/proposals/${p.id}/approve`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).settledBy).toEqual({ actor: "helix", user: os.userInfo().username }); // approved in the Helix, by whoever runs it
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe(store.get(p.id).changes[0].after!);
    expect(store.get(p.id).status).toBe("approved");
    await b.close();
  });
  it("stale proposals halt in the UI exactly as on the CLI", async () => {
    const { root, b, store, api } = await bridge({ "a.md": "x" });
    const p = store.proposeWrite("a.md", "agent version", "agent-x");
    fs.writeFileSync(path.join(root, "a.md"), "human edit");
    const r = await api(`/api/proposals/${p.id}/approve`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body).status).toBe("stale");
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("human edit");
    await b.close();
  });
  it("reject works; approve/reject are GET-proof and refused in read-only mode", async () => {
    const { b, store, api } = await bridge({ "a.md": "x" });
    const p = store.proposeWrite("a.md", "y", "agent-x");
    expect((await api(`/api/proposals/${p.id}/approve`)).status).toBe(404); // GET must never settle
    expect((await api(`/api/proposals/${p.id}/reject`, { method: "POST" })).status).toBe(200);
    expect(store.get(p.id).status).toBe("rejected");
    await b.close();

    const ro = await bridge({ "a.md": "x" }, true);
    const q = ro.store.proposeWrite("a.md", "y", "agent-x");
    expect((await ro.api(`/api/proposals/${q.id}/approve`, { method: "POST" })).status).toBe(403);
    expect(ro.store.get(q.id).status).toBe("pending");
    expect(JSON.parse((await ro.api("/api/graph")).body).readOnly).toBe(true);
    await ro.b.close();
  });
  it("version bumps when a note changes on disk or a proposal arrives, and not otherwise", async () => {
    const { root, b, store, api } = await bridge({ "a.md": "x" });
    const v = async () => JSON.parse((await api("/api/version")).body).version;
    const v0 = await v();
    expect(await v()).toBe(v0);
    fs.writeFileSync(path.join(root, "b.md"), "new note");
    const v1 = await v();
    expect(v1).toBeGreaterThan(v0);
    store.proposeWrite("a.md", "z", "agent-x");
    expect(await v()).toBeGreaterThan(v1);
    await b.close();
  });
  it("bad proposal ids are rejected, not crashed on", async () => {
    const { b, api } = await bridge({ "a.md": "x" });
    expect((await api("/api/proposals/nope-123")).status).toBe(400);
    expect((await api("/api/proposals/../../etc")).status).toBe(404);
    await b.close();
  });
});
