import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { capDiff } from "./diff.js";
import { MAX_NOTE_BYTES } from "./proposals.js";
import { Index } from "./indexer.js";
import { makeLogger } from "./log.js";
import { ProposalStore, type Proposal } from "./proposals.js";
import { parseFrontmatter } from "./links.js";
import { listRequests, REQUESTS_DIR } from "./requests.js";
import { Vault, VaultError } from "./vault.js";

export const DAILY_DIR = "daily";

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof VaultError ? e.message : "Internal error" }],
});

export interface ServerOptions {
  /** Do not register any write tool at all. */
  readOnly?: boolean;
  /**
   * Who this connection is, from the hub's access key (e.g. "office-thinkcentre"). When set, it is
   * recorded as the proposer instead of the name the agent reports about itself, which it chooses.
   */
  clientName?: string;
}

export function createServer(vault: Vault, opts: ServerOptions = {}) {
  const index = new Index(vault);
  const proposals = new ProposalStore(vault);
  const log = makeLogger(vault);
  const server = new McpServer({ name: "mnemo", version: "0.1.0" });
  const self = () => server.server.getClientVersion()?.name ?? "unknown";
  const client = () => (opts.clientName ? `${opts.clientName} (${self()})` : self());

  /** Wrap a tool: sync the index, log the call, convert vault errors to tool errors. */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    fn: (args: z.infer<z.ZodObject<S>>) => unknown,
    readOnly = true,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          index.sync();
          const out = fn(args);
          log("tool", { name, client: client(), ok: true });
          return text(out as any);
        } catch (e) {
          log("tool", { name, client: client(), ok: false, error: e instanceof Error ? e.message : String(e) });
          return fail(e);
        }
      }) as any,
    );

  const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "ISO date, e.g. 2026-10-23").optional();
  const ms = (d?: string, endOfDay = false) => (d ? Date.parse(d) + (endOfDay && d.length === 10 ? 86_399_999 : 0) : undefined);

  tool("search_notes", "Full-text search (BM25 over title, tags, body; prefix match on the last word). Optional folder, tag and modified-date filters.", {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
    folder: z.string().optional(),
    tag: z.string().optional(),
    after: dateArg,
    before: dateArg,
  }, ({ query, limit, folder, tag, after, before }) => {
    if (folder) vault.normalize(folder.replace(/\/+$/, "") + "/x.md");
    return index.search(query, limit, { folder, tag, after: ms(after), before: ms(before, true) });
  });

  tool("read_note", "Read a note: content, parsed frontmatter, outgoing links and backlinks.", { path: z.string() }, ({ path }) => {
    const rel = vault.normalize(path);
    const content = vault.read(rel);
    const n = index.neighbors(rel, 1);
    return {
      path: rel,
      content,
      frontmatter: parseFrontmatter(content).fm,
      outgoing: n?.outgoing.map((o) => o.path) ?? [],
      unresolvedLinks: n?.unresolved ?? [],
      backlinks: index.backlinks(rel),
    };
  });

  tool("list_recent", "Most recently modified notes (default 20).", { limit: z.number().int().min(1).max(100).default(20) }, ({ limit }) =>
    index.recent(limit),
  );

  tool("list_notes", "Browse a folder: sub-folders with note counts, and the notes under it.", {
    folder: z.string().default(""),
    limit: z.number().int().min(1).max(500).default(200),
    offset: z.number().int().min(0).default(0),
  }, ({ folder, limit, offset }) => {
    if (folder) vault.normalize(folder.replace(/\/+$/, "") + "/x.md");
    return { folders: index.folders(folder), notes: index.list(folder, limit, offset) };
  });

  tool("get_backlinks", "Notes that link to the given note, each with the line containing the link.", { path: z.string() }, ({ path }) =>
    index.backlinks(vault.normalize(path)),
  );

  tool("daily_note", `Today's (or a given date's) daily note at ${DAILY_DIR}/YYYY-MM-DD.md. Read-only: use write_note to create it.`, {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }, ({ date }) => {
    const d = date ?? localDate();
    const rel = `${DAILY_DIR}/${d}.md`;
    return vault.exists(rel) ? { path: rel, exists: true, content: vault.read(rel) } : { path: rel, exists: false, content: null };
  });

  tool("get_neighbors", "Graph around a note: outgoing, incoming and unresolved links, unlinked `related` notes (shared links/tags), plus nodes/edges out to `depth` hops.", {
    path: z.string(),
    depth: z.number().int().min(1).max(3).default(1),
  }, ({ path, depth }) => {
    const rel = vault.normalize(path);
    const r = index.neighbors(rel, depth);
    if (!r) throw new VaultError(`Note not found: ${rel}`);
    return r;
  });

  tool("find_similar", "Structurally similar notes (shared links, shared linkers, shared tags, folder). Returns score 0..1 and reasons.", {
    path: z.string(),
    limit: z.number().int().min(1).max(50).default(10),
  }, ({ path, limit }) => {
    const rel = vault.normalize(path);
    const r = index.similar(rel, limit);
    if (!r) throw new VaultError(`Note not found: ${rel}`);
    return r;
  });

  tool("get_tags", "List all #tags with counts, or the notes carrying one tag.", { tag: z.string().optional() }, ({ tag }) => index.tags(tag));

  tool("list_proposals", "List proposals and their status (pending, approved, rejected, expired, stale).", {
    status: z.enum(["pending", "approved", "rejected", "expired", "stale"]).optional(),
  }, ({ status }) => proposals.list(status).map(({ changes: _c, ...p }) => p));

  tool("list_requests", `Requests the vault's owner has written for agents: notes in ${REQUESTS_DIR}/. Read one with read_note. Agents cannot change them; answer one by proposing changes elsewhere with "request" set to its path. Status: open, in-progress (an answer awaits the owner), addressed (the owner approved an answer) or closed (the owner marked it done).`, {
    status: z.enum(["open", "in-progress", "addressed", "closed"]).optional(),
  }, ({ status }) => listRequests(vault, proposals).filter((r) => !status || r.status === status));

  if (!opts.readOnly) {
    const done = (p: Proposal) => {
      log("proposal", { id: p.id, op: p.op, path: p.path, client: p.client, ...(p.request ? { request: p.request } : {}) });
      return {
        id: p.id,
        status: p.status,
        expiresAt: p.expiresAt,
        ...(p.request ? { request: p.request } : {}),
        message: "Proposal saved. Nothing was written. A human must approve it with `mnemo-ctl approve`.",
        diff: capDiff(p.diff, 200) + (p.diff.split("\n").length > 200 ? "\n(full diff: `mnemo-ctl show " + p.id + "`)" : ""),
      };
    };
    const w = false;
    const request = z.string().optional().describe(`Path of the owner request (in ${REQUESTS_DIR}/) this proposal answers, if any`);
    tool("write_note", "Propose creating or replacing a note. Does NOT modify the vault; a human approves it.", {
      path: z.string(), content: z.string().max(MAX_NOTE_BYTES), request,
    }, ({ path, content, request }) => done(proposals.proposeWrite(path, content, client(), request)), w);
    tool("append_note", "Propose appending text to an existing note. Does NOT modify the vault.", {
      path: z.string(), content: z.string().max(MAX_NOTE_BYTES), request,
    }, ({ path, content, request }) => done(proposals.proposeAppend(path, content, client(), request)), w);
    tool("patch_note", "Propose replacing one exact passage. `anchor` must match exactly once, otherwise the call fails and nothing is proposed.", {
      path: z.string(), anchor: z.string().min(1).max(MAX_NOTE_BYTES), replacement: z.string().max(MAX_NOTE_BYTES), request,
    }, ({ path, anchor, replacement, request }) => done(proposals.proposePatch(path, anchor, replacement, client(), request)), w);
    tool("move_note", "Propose moving/renaming a note. Inbound [[wikilinks]] are rewritten in the same proposal.", {
      from: z.string(), to: z.string(), request,
    }, ({ from, to, request }) => done(proposals.proposeMove(from, to, client(), request)), w);
    tool("delete_note", "Propose deleting a note. On approval it moves to .mnemo/trash/, never destroyed.", {
      path: z.string(), request,
    }, ({ path, request }) => done(proposals.proposeDelete(path, client(), request)), w);
  }

  return { server, close: () => index.close() };
}
