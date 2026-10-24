import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { graphPayload } from "./graph.js";
import { Index } from "./indexer.js";
import { makeLogger } from "./log.js";
import { ProposalStore, type SettledBy } from "./proposals.js";
import { createServer as createMcpServer } from "./server.js";
import { TokenStore, type TokenRecord } from "./tokens.js";
import { Vault, VaultError } from "./vault.js";

/**
 * The bridge / hub: a human-side web server. `mnemo-ctl ui` runs it on loopback for the Helix;
 * `mnemo-ctl hub` additionally serves MCP over HTTP (/mcp) and may listen on this machine's
 * Tailscale address, so other machines on the tailnet can join the same vault.
 *
 * Guards (all tested in bridge.test.ts / hub.test.ts):
 *   - listens on loopback and, optionally, Tailscale addresses only (100.64.0.0/10, fd7a:115c:a1e0::/48);
 *   - Host must be one of this server's own names (defeats DNS rebinding);
 *   - cross-origin Origin refused; no CORS headers are ever sent;
 *   - Helix API: the local session key, or a person key from `mnemo-ctl token add --person`;
 *   - MCP: agent keys only (`Authorization: Bearer ...`); an agent key can never reach approval;
 *     each MCP session is pinned to the key that opened it; proposals record the key's name;
 *   - read-only keys (and --read-only) get no write tools and no approve/reject.
 * Approve/reject call the same ProposalStore as mnemo-ctl, so what lands is identical.
 */
export interface BridgeOptions {
  port?: number; // 0 picks a free port
  uiDir: string;
  readOnly?: boolean;
  /** Fixed local session key (tests); random otherwise. */
  token?: string;
  /** Extra addresses to listen on; each must be loopback or Tailscale. */
  bind?: string[];
  /** Extra Host names to accept, e.g. this Mac's MagicDNS name. */
  allowHosts?: string[];
  /** Serve MCP over HTTP at /mcp (hub mode). Requires agent keys. */
  mcp?: boolean;
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

/** MCP request bodies: above the 10 MB note cap even after JSON escaping, so the app refuses cleanly. */
const MAX_BODY = 64 * 1024 * 1024;
const MAX_SESSIONS = 64;

/** Loopback or Tailscale only. Never 0.0.0.0, never a LAN or public interface. */
export function isAllowedBind(addr: string): boolean {
  const v = net.isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split(".").map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const a = addr.toLowerCase();
    return a === "::1" || /^fd7a:115c:a1e0:/.test(a);
  }
  return false;
}

const hostWithPort = (addr: string, port: number) => (net.isIP(addr) === 6 ? `[${addr}]:${port}` : `${addr}:${port}`);

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startBridge(vault: Vault, opts: BridgeOptions) {
  for (const a of opts.bind || []) if (!isAllowedBind(a)) throw new VaultError(`Refusing to listen on ${a}: Mnemo listens only on this machine (127.0.0.1) and Tailscale addresses (100.x / fd7a:115c:a1e0::)`);
  const token = opts.token ?? crypto.randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const keys = new TokenStore(vault);
  const index = new Index(vault);
  const store = new ProposalStore(vault);
  const log = makeLogger(vault);
  let version = 1;
  let proposalPrint = "";
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; key: string; close: () => void }>();

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

  let port = 0;
  const allowedHosts = () => {
    const hs = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    for (const a of opts.bind || []) hs.push(hostWithPort(a, port));
    for (const h of opts.allowHosts || []) hs.push(h.toLowerCase(), `${h.toLowerCase()}:${port}`);
    return hs;
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json; charset=utf-8", extra: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { ...SECURITY_HEADERS, ...extra, "Content-Type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const hosts = allowedHosts();
    const host = (req.headers.host || "").toLowerCase();
    if (!hosts.includes(host)) return send(403, { error: "bad host" });
    const origin = req.headers.origin;
    if (origin && !hosts.some((h) => origin.toLowerCase() === `http://${h}` || origin.toLowerCase() === `https://${h}`)) return send(403, { error: "cross-origin request refused" });

    const url = new URL(req.url || "/", `http://${host}`);
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

    // ---- MCP over HTTP (hub mode): agent keys only ----
    if (url.pathname === "/mcp") {
      if (!opts.mcp) return send(404, { error: "not found" });
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
      const key = keys.verify(bearer ? bearer[1] : undefined);
      if (!key || key.kind !== "agent") {
        log("hub", { event: "mcp-auth-refused", from: req.socket.remoteAddress });
        return send(401, { error: "an agent key is required: Authorization: Bearer <key from mnemo-ctl token add --agent>" }, undefined, { "WWW-Authenticate": "Bearer" });
      }
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const s = sessions.get(sid);
        if (!s) return send(404, { error: "unknown or closed session" });
        if (s.key !== key.name) return send(403, { error: "session belongs to another key" });
        if (req.method === "POST") {
          const raw = await readBody(req, MAX_BODY);
          if (raw === null) return send(413, { error: "request too large" });
          let body: unknown;
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            return send(400, { error: "invalid JSON" });
          }
          return s.transport.handleRequest(req, res, body);
        }
        return s.transport.handleRequest(req, res);
      }
      if (req.method !== "POST") return send(400, { error: "start a session with an initialize request" });
      if (sessions.size >= MAX_SESSIONS) return send(503, { error: "too many open sessions" });
      const raw = await readBody(req, MAX_BODY);
      if (raw === null) return send(413, { error: "request too large" });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      const { server, close } = createMcpServer(vault, { readOnly: key.readOnly || !!opts.readOnly, clientName: key.name });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        maxRequestBodySize: MAX_BODY,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, key: key.name, close });
          log("hub", { event: "mcp-session", key: key.name, from: req.socket.remoteAddress });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        close();
      };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });

    // ---- Helix API: the local session key, or a person key ----
    const presented = String(req.headers["x-mnemo-token"] || "");
    const given = Buffer.from(presented);
    let person: TokenRecord | null = null;
    const local = given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
    if (!local) {
      person = keys.verify(presented);
      if (!person || person.kind !== "person") return send(401, { error: "missing or wrong key" });
    }
    const readOnly = !!opts.readOnly || !!(person && person.readOnly);
    const by: SettledBy = person ? { actor: "helix", user: person.name } : store.human("helix");

    try {
      if (req.method === "GET" && url.pathname === "/api/version") return send(200, { version: refresh() });
      if (req.method === "GET" && url.pathname === "/api/graph") {
        refresh();
        return send(200, { ...graphPayload(vault, index, store), live: true, readOnly, version, viewer: person ? person.name : "this computer" });
      }
      const m = url.pathname.match(/^\/api\/proposals\/([a-z0-9-]+)(?:\/(approve|reject))?$/);
      if (m && req.method === "GET" && !m[2]) {
        const p = store.get(m[1]);
        return send(200, { id: p.id, op: p.op, path: p.path, to: p.to, client: p.client, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, touches: p.changes.map((c) => c.path), diff: p.diff });
      }
      if (m && req.method === "POST" && m[2]) {
        if (readOnly) return send(403, { error: "read-only: approve and reject are disabled" });
        try {
          const p = m[2] === "approve" ? store.approve(m[1], by) : store.reject(m[1], by);
          log("hub", { event: m[2], id: p.id, by });
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
  };

  const servers: http.Server[] = [];
  const listen = (addr: string, p: number) =>
    new Promise<http.Server>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        handler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, SECURITY_HEADERS);
            res.end();
          }
        });
      });
      srv.once("error", reject);
      srv.listen(p, addr, () => resolve(srv));
    });
  const first = await listen("127.0.0.1", opts.port ?? 7337);
  servers.push(first);
  port = (first.address() as net.AddressInfo).port;
  try {
    for (const a of opts.bind || []) if (a !== "127.0.0.1") servers.push(await listen(a, port));
  } catch (e) {
    for (const s of servers) s.close();
    index.close();
    throw e;
  }

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    addresses: servers.map((s) => s.address() as net.AddressInfo),
    /** Kept for existing callers: the loopback listener's address. */
    address: first.address(),
    close: async () => {
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              s.close(() => r());
              s.closeAllConnections(); // idle keep-alives and open MCP streams would otherwise hold close() open
            }),
        ),
      );
      index.close();
    },
  };
}
