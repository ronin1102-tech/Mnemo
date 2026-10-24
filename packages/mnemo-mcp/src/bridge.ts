import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { graphPayload } from "./graph.js";
import { Index } from "./indexer.js";
import { ProposalStore } from "./proposals.js";
import { Vault, VaultError } from "./vault.js";

/**
 * The local bridge: a human-side web server for the Helix UI. It is NOT an MCP transport; agents
 * still reach Mnemo only over stdio. It serves the built UI and a small API on 127.0.0.1, and
 * guards every API call so no other web page or local process can use it:
 *   - bound to the loopback interface only;
 *   - Host header must be this loopback origin (defeats DNS rebinding);
 *   - a cross-origin Origin header is refused (and the API never sends CORS headers);
 *   - a per-session random token, delivered to the page in the URL fragment (never sent over the
 *     network), must accompany every API request.
 * Approve/reject call the same ProposalStore methods as mnemo-ctl, so what lands is identical.
 */
export interface BridgeOptions {
  port?: number; // 0 picks a free port
  uiDir: string;
  readOnly?: boolean;
  token?: string;
}

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
};

export async function startBridge(vault: Vault, opts: BridgeOptions) {
  const token = opts.token ?? crypto.randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const index = new Index(vault);
  const store = new ProposalStore(vault);
  let version = 1;
  let proposalPrint = "";

  /** Bump the version when notes or proposals change; the UI polls it to stay live. */
  const refresh = () => {
    const notesChanged = index.sync();
    const dir = vault.ensureState("proposals");
    const print = fs.readdirSync(dir).map((f) => f + ":" + fs.statSync(path.join(dir, f)).mtimeMs).sort().join("|");
    if (notesChanged || print !== proposalPrint) {
      proposalPrint = print;
      version++;
    }
    return version;
  };
  refresh();

  const server = http.createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    const send = (status: number, body: unknown, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host || "")) return send(403, { error: "bad host" });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return send(403, { error: "cross-origin request refused" });

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      try {
        return send(200, fs.readFileSync(path.join(opts.uiDir, file)), type);
      } catch {
        return send(500, "UI not built: run `npm run build`", "text/plain; charset=utf-8");
      }
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    // live mode has no snapshot file; answer the page's optional <script src="graph.js"> quietly
    if (req.method === "GET" && url.pathname === "/graph.js") return send(200, "/* live: data comes from /api/graph */", "text/javascript; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });

    const given = Buffer.from(String(req.headers["x-mnemo-token"] || ""));
    if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) return send(401, { error: "missing or wrong session token" });

    try {
      if (req.method === "GET" && url.pathname === "/api/version") return send(200, { version: refresh() });
      if (req.method === "GET" && url.pathname === "/api/graph") {
        refresh();
        return send(200, { ...graphPayload(vault, index, store), live: true, readOnly: !!opts.readOnly, version });
      }
      const m = url.pathname.match(/^\/api\/proposals\/([a-z0-9-]+)(?:\/(approve|reject))?$/);
      if (m && req.method === "GET" && !m[2]) {
        const p = store.get(m[1]);
        return send(200, { id: p.id, op: p.op, path: p.path, to: p.to, client: p.client, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, touches: p.changes.map((c) => c.path), diff: p.diff });
      }
      if (m && req.method === "POST" && m[2]) {
        if (opts.readOnly) return send(403, { error: "read-only: approve and reject are disabled" });
        try {
          const p = m[2] === "approve" ? store.approve(m[1]) : store.reject(m[1]);
          refresh();
          return send(200, { id: p.id, status: p.status, path: p.path, to: p.to, settledBy: p.settledBy });
        } catch (e) {
          refresh();
          return send(409, { error: e instanceof Error ? e.message : String(e), status: store.get(m[1]).status });
        }
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(e instanceof VaultError ? 400 : 500, { error: e instanceof VaultError ? e.message : "internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7337, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () => new Promise<void>((r) => server.close(() => { index.close(); r(); })),
    address: server.address(),
  };
}
