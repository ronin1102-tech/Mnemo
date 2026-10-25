import type { Index, NoteMeta } from "./indexer.js";
import { parseFrontmatter } from "./links.js";
import type { ProposalStore } from "./proposals.js";
import { listRequests } from "./requests.js";
import type { Vault } from "./vault.js";

/** First ~160 characters of the body, without frontmatter or the leading heading. */
export function excerpt(text: string): string {
  const body = parseFrontmatter(text).body.replace(/^\s*#\s+.*\n?/, "");
  const flat = body.replace(/\[\[([^\]|#]*)[^\]]*\]\]/g, "$1").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 159) + "…" : flat;
}

/** What the Helix UI draws: every note, every resolved link, and the pending proposals. */
export function graphPayload(vault: Vault, index: Index, store: ProposalStore) {
  const graph = index.graph();
  for (const n of graph.nodes as (NoteMeta & { excerpt?: string })[]) n.excerpt = excerpt(vault.read(n.path));
  const proposals = store.list("pending").map((p) => ({
    id: p.id,
    path: p.path,
    to: p.to,
    op: p.op,
    client: p.client,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    exists: graph.nodes.some((n) => n.path === p.path),
    ...(p.request ? { request: p.request } : {}),
  }));
  return { generatedAt: new Date().toISOString(), ...graph, proposals, requests: listRequests(vault, store) };
}
