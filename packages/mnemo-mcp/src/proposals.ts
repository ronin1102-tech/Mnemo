import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lineDiff } from "./diff.js";
import { Vault, VaultError } from "./vault.js";

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NOTE_BYTES = 1_000_000;

export type ProposalOp = "write" | "append" | "delete";
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Proposal {
  id: string;
  op: ProposalOp;
  path: string;
  client: string;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  /** sha256 of the note when proposed, or null if it did not exist. Approval fails if disk has moved on. */
  baseHash: string | null;
  after: string | null;
  diff: string;
  resolvedAt?: string;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The write gate. Agent-facing code can only call `propose`. `approve`, `reject`
 * and `purgeTrash` exist for the human CLI and are never registered as MCP tools.
 * There is deliberately no option anywhere to skip this step.
 */
export class ProposalStore {
  private dir: string;

  constructor(
    private vault: Vault,
    private now: () => number = Date.now,
  ) {
    this.dir = vault.ensureState("proposals");
  }

  private file(id: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new VaultError("Invalid proposal id");
    return path.join(this.dir, `${id}.json`);
  }

  private save(p: Proposal) {
    fs.writeFileSync(this.file(p.id), JSON.stringify(p, null, 2));
  }

  propose(op: ProposalOp, rel: string, content: string | null, client: string): Proposal {
    const { rel: p, abs } = this.vault.resolve(rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (op === "delete" && current === null) throw new VaultError(`Note not found: ${p}`);
    if (op === "append" && current === null) throw new VaultError(`Cannot append to missing note: ${p}`);
    let after: string | null = null;
    if (op === "write") after = content ?? "";
    if (op === "append") after = current + (current!.endsWith("\n") || current === "" ? "" : "\n") + (content ?? "");
    if (after !== null && Buffer.byteLength(after) > MAX_NOTE_BYTES) throw new VaultError("Note exceeds 1MB limit");
    const created = this.now();
    const proposal: Proposal = {
      id: `${new Date(created).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
      op,
      path: p,
      client: client || "unknown",
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + PROPOSAL_TTL_MS).toISOString(),
      status: "pending",
      baseHash: current === null ? null : sha(current),
      after,
      diff: lineDiff(current ?? "", after ?? ""),
    };
    this.save(proposal);
    return proposal;
  }

  /** Mark overdue pending proposals expired. Runs on every read of the store. */
  expireOverdue(): number {
    let n = 0;
    for (const p of this.readAll()) {
      if (p.status === "pending" && Date.parse(p.expiresAt) <= this.now()) {
        p.status = "expired";
        p.resolvedAt = new Date(this.now()).toISOString();
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

  /** Human-only. Applies the proposal to disk. */
  approve(id: string): Proposal {
    const p = this.pending(id);
    const { abs } = this.vault.resolve(p.path);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if ((current === null ? null : sha(current)) !== p.baseHash) {
      throw new VaultError(`Note ${p.path} changed since this was proposed; reject it and ask the agent to re-propose`);
    }
    if (p.op === "delete") {
      this.moveToTrash(p.path);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      this.vault.resolve(p.path); // re-check jail after mkdir
      const tmp = `${abs}.mnemo-tmp-${process.pid}`;
      fs.writeFileSync(tmp, p.after ?? "");
      fs.renameSync(tmp, abs);
    }
    p.status = "approved";
    p.resolvedAt = new Date(this.now()).toISOString();
    this.save(p);
    return p;
  }

  reject(id: string): Proposal {
    const p = this.pending(id);
    p.status = "rejected";
    p.resolvedAt = new Date(this.now()).toISOString();
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
