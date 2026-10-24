import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineDiff } from "./diff.js";
import { rewriteLinks } from "./links.js";
import { Vault, VaultError } from "./vault.js";

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NOTE_BYTES = 10_000_000;

export type ProposalOp = "write" | "append" | "patch" | "move" | "delete";
/** `stale` = the vault moved on after the proposal was made; approval halted and nothing was applied. */
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "stale";

/** One note a proposal depends on. `after: null` means "check only, don't rewrite content". */
export interface Change {
  path: string;
  /** sha256 of the note when proposed, or null if it did not exist. */
  baseHash: string | null;
  after: string | null;
}

/** Who settled a proposal. There is no user system: the point is proposer (`client`) vs settler. */
export interface SettledBy {
  /** mnemo-ctl (command line), helix (approved in the Helix view), or expiry. */
  actor: "mnemo-ctl" | "helix" | "expiry";
  /** OS username for local use, or the person key's name for someone on the tailnet. */
  user?: string;
}

export interface Proposal {
  id: string;
  op: ProposalOp;
  path: string;
  /** Destination for `move`. */
  to?: string;
  client: string;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  changes: Change[];
  diff: string;
  /** When it was settled (approved, rejected, expired or halted as stale). */
  resolvedAt?: string;
  settledBy?: SettledBy;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The write gate. Agent-facing code can only call the propose* methods.
 * `approve`, `reject` and `purgeTrash` exist for the human CLI (mnemo-ctl) and
 * are never registered as MCP tools. There is deliberately no way to skip this step.
 */
export class ProposalStore {
  private dir: string;

  constructor(
    private vault: Vault,
    private now: () => number = Date.now,
  ) {
    this.dir = vault.ensureState("proposals");
  }

  /** Whoever is running this process on this machine. */
  human(actor: "mnemo-ctl" | "helix" = "mnemo-ctl"): SettledBy {
    let user: string | undefined;
    try {
      user = os.userInfo().username;
    } catch {
      /* no passwd entry (some containers): record the actor alone */
    }
    return { actor, ...(user ? { user } : {}) };
  }

  private file(id: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new VaultError("Invalid proposal id");
    return path.join(this.dir, `${id}.json`);
  }

  private save(p: Proposal) {
    fs.writeFileSync(this.file(p.id), JSON.stringify(p, null, 2));
  }

  private readCurrent(rel: string): string | null {
    const { abs } = this.vault.resolve(rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  }

  private limit(s: string) {
    if (Buffer.byteLength(s) > MAX_NOTE_BYTES) throw new VaultError("Note exceeds 10MB limit");
  }

  private create(op: ProposalOp, rel: string, changes: Change[], diff: string, client: string, to?: string): Proposal {
    const created = this.now();
    const p: Proposal = {
      id: `${new Date(created).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
      op,
      path: rel,
      ...(to ? { to } : {}),
      client: client || "unknown",
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + PROPOSAL_TTL_MS).toISOString(),
      status: "pending",
      changes,
      diff,
    };
    this.save(p);
    return p;
  }

  private single(op: ProposalOp, rel: string, current: string | null, after: string | null, client: string) {
    if (after !== null) this.limit(after);
    return this.create(op, rel, [{ path: rel, baseHash: current === null ? null : sha(current), after }], lineDiff(current ?? "", after ?? ""), client);
  }

  /** Create or replace a note. */
  proposeWrite(rel: string, content: string, client: string): Proposal {
    const p = this.vault.normalize(rel);
    return this.single("write", p, this.readCurrent(p), content, client);
  }

  proposeAppend(rel: string, content: string, client: string): Proposal {
    const p = this.vault.normalize(rel);
    const cur = this.readCurrent(p);
    if (cur === null) throw new VaultError(`Cannot append to missing note: ${p}`);
    return this.single("append", p, cur, cur + (cur === "" || cur.endsWith("\n") ? "" : "\n") + content, client);
  }

  /** Replace one exact occurrence of `anchor`. Fails closed: zero or multiple matches is an error, never a guess. */
  proposePatch(rel: string, anchor: string, replacement: string, client: string): Proposal {
    const p = this.vault.normalize(rel);
    const cur = this.readCurrent(p);
    if (cur === null) throw new VaultError(`Note not found: ${p}`);
    if (Buffer.byteLength(cur) > MAX_NOTE_BYTES) throw new VaultError("Note is over 10MB: readable, but not patchable");
    if (anchor === "") throw new VaultError("Anchor must not be empty");
    const first = cur.indexOf(anchor);
    if (first < 0) throw new VaultError("Anchor not found; nothing proposed");
    if (cur.indexOf(anchor, first + 1) >= 0) throw new VaultError("Anchor matches more than once; use a longer, unique anchor");
    return this.single("patch", p, cur, cur.slice(0, first) + replacement + cur.slice(first + anchor.length), client);
  }

  proposeDelete(rel: string, client: string): Proposal {
    const p = this.vault.normalize(rel);
    const cur = this.readCurrent(p);
    if (cur === null) throw new VaultError(`Note not found: ${p}`);
    return this.single("delete", p, cur, null, client);
  }

  /** Move/rename a note and rewrite every inbound wikilink in the same proposal. */
  proposeMove(fromRel: string, toRel: string, client: string): Proposal {
    const from = this.vault.normalize(fromRel);
    const to = this.vault.normalize(toRel);
    if (from === to) throw new VaultError("Source and destination are the same");
    const cur = this.readCurrent(from);
    if (cur === null) throw new VaultError(`Note not found: ${from}`);
    if (this.readCurrent(to) !== null) throw new VaultError(`Destination already exists: ${to}`);
    const all = this.vault.listAll();
    const changes: Change[] = [{ path: from, baseHash: sha(cur), after: null }];
    const parts = [`move ${from} -> ${to}`];
    for (const other of all) {
      if (other === from) continue;
      const body = this.vault.read(other);
      const next = rewriteLinks(body, all, other, from, to);
      if (next === body) continue;
      this.limit(next);
      changes.push({ path: other, baseHash: sha(body), after: next });
      parts.push(`\n@@ ${other} (link rewrite)\n${lineDiff(body, next)}`);
    }
    return this.create("move", from, changes, parts.join("\n"), client, to);
  }

  /** Mark overdue pending proposals expired. Runs on every read of the store. */
  expireOverdue(): number {
    let n = 0;
    for (const p of this.readAll()) {
      if (p.status === "pending" && Date.parse(p.expiresAt) <= this.now()) {
        p.status = "expired";
        p.resolvedAt = new Date(this.now()).toISOString();
        p.settledBy = { actor: "expiry" };
        this.save(p);
        n++;
      }
    }
    return n;
  }

  private readAll(): Proposal[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Proposal)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  list(status?: ProposalStatus): Proposal[] {
    this.expireOverdue();
    const all = this.readAll();
    return status ? all.filter((p) => p.status === status) : all;
  }

  get(id: string): Proposal {
    this.expireOverdue();
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new VaultError(`Proposal not found: ${id}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  private pending(id: string): Proposal {
    const p = this.get(id);
    if (p.status !== "pending") throw new VaultError(`Proposal ${id} is ${p.status}`);
    return p;
  }

  /**
   * Human-only. Everything is validated before anything is written: if any note
   * the proposal depends on changed, the proposal is marked stale and the whole
   * approval halts with the vault untouched.
   */
  approve(id: string, by: SettledBy = this.human()): Proposal {
    const p = this.pending(id);
    const halt = (why: string): never => {
      p.status = "stale";
      p.resolvedAt = new Date(this.now()).toISOString();
      p.settledBy = by;
      this.save(p);
      throw new VaultError(`Proposal ${id} is stale: ${why}. Nothing was applied; ask the agent to re-propose`);
    };
    for (const c of p.changes) {
      const cur = this.readCurrent(c.path);
      if ((cur === null ? null : sha(cur)) !== c.baseHash) halt(`${c.path} changed since it was proposed`);
    }
    if (p.op === "move" && this.readCurrent(p.to as string) !== null) halt(`destination ${p.to} now exists`);
    if (p.op === "move") this.vault.resolve(p.to as string);

    if (p.op === "delete") this.moveToTrash(p.path);
    else if (p.op === "move") {
      for (const c of p.changes) if (c.after !== null) this.vault.atomicWrite(c.path, c.after);
      const dest = this.vault.resolve(p.to as string);
      fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
      this.vault.resolve(p.to as string);
      fs.renameSync(this.vault.resolve(p.path).abs, dest.abs);
    } else {
      this.vault.atomicWrite(p.path, p.changes[0].after ?? "");
    }
    p.status = "approved";
    p.resolvedAt = new Date(this.now()).toISOString();
    p.settledBy = by;
    this.save(p);
    return p;
  }

  reject(id: string, by: SettledBy = this.human()): Proposal {
    const p = this.pending(id);
    p.status = "rejected";
    p.resolvedAt = new Date(this.now()).toISOString();
    p.settledBy = by;
    this.save(p);
    return p;
  }

  /** Agent deletions land here, never in the void. */
  private moveToTrash(rel: string) {
    const { abs } = this.vault.resolve(rel);
    const trash = this.vault.ensureState("trash");
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    fs.renameSync(abs, path.join(trash, `${stamp}__${rel.replace(/\//g, "__")}`));
  }

  /** Human-only: the only true deletion in the system. */
  purgeTrash(): number {
    const trash = this.vault.ensureState("trash");
    const files = fs.readdirSync(trash);
    for (const f of files) fs.rmSync(path.join(trash, f), { force: true });
    return files.length;
  }
}
