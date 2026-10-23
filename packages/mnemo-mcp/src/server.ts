import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Index } from "./indexer.js";
import { makeLogger } from "./log.js";
import { ProposalStore, type Proposal } from "./proposals.js";
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
}

export function createServer(vault: Vault, opts: ServerOptions = {}) {
  const index = new Index(vault);
  const proposals = new ProposalStore(vault);
  const log = makeLogger(vault);
  const server = new McpServer({ name: "mnemo", version: "0.1.0" });
  const client = () => server.server.getClientVersion()?.name ?? "unknown";

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

  tool("search_notes", "Full-text search across the vault (BM25, prefix match on the last word).", {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
  }, ({ query, limit }) => index.search(query, limit));

  tool("read_note", "Read a note by vault-relative path.", { path: z.string() }, ({ path }) => {
    const rel = vault.normalize(path);
    return { path: rel, content: vault.read(rel) };
  });

  tool("list_recent", "Most recently modified notes.", { limit: z.number().int().min(1).max(100).default(10) }, ({ limit }) =>
    index.recent(limit),
  );

  tool("list_notes", "List notes, optionally within a folder.", {
    folder: z.string().default(""),
    limit: z.number().int().min(1).max(500).default(200),
    offset: z.number().int().min(0).default(0),
  }, ({ folder, limit, offset }) => {
    if (folder) vault.normalize(folder.replace(/\/+$/, "") + "/x.md");
    return index.list(folder, limit, offset);
  });

  tool("get_backlinks", "Notes that link to the given note via [[wikilinks]].", { path: z.string() }, ({ path }) =>
    index.backlinks(vault.normalize(path)),
  );

  tool("daily_note", `Today's (or a given date's) daily note at ${DAILY_DIR}/YYYY-MM-DD.md. Read-only: use propose_write to create it.`, {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }, ({ date }) => {
    const d = date ?? localDate();
    const rel = `${DAILY_DIR}/${d}.md`;
    return vault.exists(rel) ? { path: rel, exists: true, content: vault.read(rel) } : { path: rel, exists: false, content: null };
  });

  tool("get_neighbors", "Link neighbourhood of a note: outgoing, incoming and unresolved links, plus nodes/edges out to `depth` hops.", {
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

  if (!opts.readOnly) {
    const done = (p: Proposal) => {
      log("proposal", { id: p.id, op: p.op, path: p.path, client: p.client });
      return {
        id: p.id,
        status: p.status,
        expiresAt: p.expiresAt,
        message: "Proposal saved. Nothing was written. A human must approve it with `mnemo-ctl approve`.",
        diff: p.diff,
      };
    };
    const w = false;
    tool("write_note", "Propose creating or replacing a note. Does NOT modify the vault; a human approves it.", {
      path: z.string(), content: z.string(),
    }, ({ path, content }) => done(proposals.proposeWrite(path, content, client())), w);
    tool("append_note", "Propose appending text to an existing note. Does NOT modify the vault.", {
      path: z.string(), content: z.string(),
    }, ({ path, content }) => done(proposals.proposeAppend(path, content, client())), w);
    tool("patch_note", "Propose replacing one exact passage. `anchor` must match exactly once, otherwise the call fails and nothing is proposed.", {
      path: z.string(), anchor: z.string().min(1), replacement: z.string(),
    }, ({ path, anchor, replacement }) => done(proposals.proposePatch(path, anchor, replacement, client())), w);
    tool("move_note", "Propose moving/renaming a note. Inbound [[wikilinks]] are rewritten in the same proposal.", {
      from: z.string(), to: z.string(),
    }, ({ from, to }) => done(proposals.proposeMove(from, to, client())), w);
    tool("delete_note", "Propose deleting a note. On approval it moves to .mnemo/trash/, never destroyed.", {
      path: z.string(),
    }, ({ path }) => done(proposals.proposeDelete(path, client())), w);
  }

  return { server, close: () => index.close() };
}
