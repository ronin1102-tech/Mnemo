import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Index } from "./indexer.js";
import { makeLogger } from "./log.js";
import { ProposalStore } from "./proposals.js";
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

export function createServer(vault: Vault) {
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

  const propose = (op: "write" | "append" | "delete", path: string, content: string | null) => {
    const p = proposals.propose(op, path, content, client());
    log("proposal", { id: p.id, op, path: p.path, client: p.client });
    return {
      id: p.id,
      status: p.status,
      expiresAt: p.expiresAt,
      message: "Proposal saved. Nothing was written. A human must approve it with `mnemo-mcp proposals approve`.",
      diff: p.diff,
    };
  };

  tool("propose_write", "Propose creating or replacing a note. Does NOT modify the vault; a human approves it.", {
    path: z.string(),
    content: z.string(),
  }, ({ path, content }) => propose("write", path, content), false);

  tool("propose_append", "Propose appending text to an existing note. Does NOT modify the vault.", {
    path: z.string(),
    content: z.string(),
  }, ({ path, content }) => propose("append", path, content), false);

  tool("propose_delete", "Propose deleting a note. On approval it moves to .mnemo/trash/, never destroyed.", {
    path: z.string(),
  }, ({ path }) => propose("delete", path, null), false);

  tool("list_proposals", "List proposals and their status (pending, approved, rejected, expired).", {
    status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  }, ({ status }) => proposals.list(status).map(({ after: _a, ...p }) => p));

  return { server, close: () => index.close() };
}
