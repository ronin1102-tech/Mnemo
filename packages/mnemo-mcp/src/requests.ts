import { extractCreated, extractTitle, parseFrontmatter } from "./links.js";
import type { Proposal, ProposalStore } from "./proposals.js";
import { Vault, VaultError } from "./vault.js";

/**
 * Owner requests: notes the owner writes in `Requests/` asking agents for something. Agents can read
 * them but never change them (the proposal store refuses any path in this folder); an agent answers
 * with ordinary proposals that name the request. A request's status is derived from those proposals,
 * so the owner's request files are never rewritten by anyone else.
 */
export const REQUESTS_DIR = "Requests";

/** Case-insensitive, because macOS folders are. */
export const isRequestPath = (rel: string) => rel.split("/")[0].toLowerCase() === REQUESTS_DIR.toLowerCase();

/**
 * open: nothing yet. in-progress: an answer is waiting for the owner. addressed: the owner approved an answer.
 * closed: the owner marked it done (frontmatter `status: done` or `closed`).
 */
export type RequestStatus = "open" | "in-progress" | "addressed" | "closed";

export interface RequestSummary {
  path: string;
  title: string;
  created: number | null;
  status: RequestStatus;
  answers: { id: string; op: Proposal["op"]; path: string; to?: string; client: string; status: Proposal["status"] }[];
}

/** Check a `request` reference on a proposal: it must be an existing note in Requests/. */
export function checkRequestRef(vault: Vault, ref: string): string {
  const rel = vault.normalize(ref);
  if (!isRequestPath(rel)) throw new VaultError(`"request" must be a note in ${REQUESTS_DIR}/ (got ${rel})`);
  if (!vault.exists(rel)) throw new VaultError(`Request not found: ${rel}`);
  return rel;
}

export function listRequests(vault: Vault, store: ProposalStore): RequestSummary[] {
  const all = store.list();
  return vault
    .listAll()
    .filter(isRequestPath)
    .map((rel) => {
      const text = vault.read(rel);
      const answers = all
        .filter((p) => p.request && p.request.toLowerCase() === rel.toLowerCase())
        .map((p) => ({ id: p.id, op: p.op, path: p.path, ...(p.to ? { to: p.to } : {}), client: p.client, status: p.status }));
      const marked = String(parseFrontmatter(text).fm.status || "").toLowerCase();
      const status: RequestStatus =
        marked === "done" || marked === "closed" ? "closed"
        : answers.some((a) => a.status === "approved") ? "addressed"
        : answers.some((a) => a.status === "pending") ? "in-progress"
        : "open";
      return { path: rel, title: extractTitle(text, rel), created: extractCreated(text), status, answers };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
