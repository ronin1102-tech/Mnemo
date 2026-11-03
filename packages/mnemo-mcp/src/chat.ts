import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Index } from "./indexer.js";
import { extractTitle, parseFrontmatter } from "./links.js";
import { Vault, VaultError } from "./vault.js";

/**
 * Copilot chat: one private channel between the vault's owner and one agent the owner chose.
 *
 * Chat is conversation, not knowledge. Messages live in Mnemo's own data folder (`.mnemo/chat/`,
 * one JSON file per conversation), never as vault notes, so no amount of chatting changes the note
 * count, the search index or the graph. Chat never writes the vault; anything the agent wants to
 * save goes through the proposal gate, and "Save to vault" is the owner's own note write.
 *
 * Who is in the channel is decided by the human (`mnemo-ctl chat setup`) and pinned to a key's name
 * AND creation time, so revoking a key and issuing a new one of the same name does not inherit access.
 */
export const MAX_BODY_CHARS = 20_000;
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREADS = 500;
/** How many matching notes may ride along with a message ("small fixed cap"), besides the open note. */
export const CONTEXT_MATCHES = 3;
export const MAX_FETCH = 20;
/** Earlier messages from the same conversation handed to the agent with each queued message. */
export const AGENT_HISTORY = 12;
const EXCERPT_CHARS = 1_200;
const MAX_CITES = 10;

export type ChatAuthor = "owner" | "agent";
/** queued: stored, waiting. delivered: the agent fetched it. answered: the agent replied after fetching it. */
export type OwnerState = "queued" | "delivered" | "answered";

/** A note shown with a message. `open`: the note the owner had open. `match`: a search hit for the message text. */
export interface ChatRef {
  path: string;
  title: string;
  why?: "open" | "match";
}

export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  at: string;
  body: string;
  /** Owner messages only. */
  state?: OwnerState;
  deliveredAt?: string;
  answeredAt?: string;
  /** Owner messages: exactly the notes shared with this message. */
  context?: ChatRef[];
  /** Agent messages: the notes the answer used. */
  cites?: ChatRef[];
  /** Agent messages: a proposal (made through the gate) that goes with this reply. */
  proposal?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  queued: number;
  /** When the agent last wrote in this conversation. */
  lastAgentAt: string | null;
}

/** A key, pinned by name and creation time. */
export interface Identity {
  name: string;
  createdAt: string;
}

export interface ChannelConfig {
  owner: Identity | null;
  agent: Identity | null;
  /** When the agent last asked for messages (even if there were none): "last picked up", never "online". */
  lastAgentSeen: string | null;
}

const THREAD_FILE = /^(\d{14}-[0-9a-f]{6})\.json$/;
const THREAD_ID = /^\d{14}-[0-9a-f]{6}$/;

let seq = 0;
const sameIdentity = (a: Identity | null | undefined, b: Identity | null | undefined) => !!a && !!b && a.name === b.name && a.createdAt === b.createdAt;
const iso = (ms: number) => new Date(ms).toISOString();

export class ChatStore {
  private dir: string;
  private cfgFile: string;

  constructor(
    vault: Vault,
    private now: () => number = Date.now,
  ) {
    this.dir = vault.ensureState("chat");
    this.cfgFile = path.join(this.dir, "channel.json");
  }

  // ---- who is in the channel -------------------------------------------------------

  config(): ChannelConfig {
    try {
      const c = JSON.parse(fs.readFileSync(this.cfgFile, "utf8")) as Partial<ChannelConfig>;
      return { owner: c.owner ?? null, agent: c.agent ?? null, lastAgentSeen: c.lastAgentSeen ?? null };
    } catch {
      return { owner: null, agent: null, lastAgentSeen: null };
    }
  }

  private saveConfig(c: ChannelConfig) {
    this.writeJson(this.cfgFile, c);
  }

  /** Human-only (mnemo-ctl). Passing a key replaces that seat; omitting it leaves it as it was. */
  setup(seats: { owner?: Identity; agent?: Identity }): ChannelConfig {
    const c = this.config();
    if (seats.owner) c.owner = seats.owner;
    if (seats.agent) {
      if (!sameIdentity(c.agent, seats.agent)) c.lastAgentSeen = null;
      c.agent = seats.agent;
    }
    this.saveConfig(c);
    return c;
  }

  isOwnerKey(k: Identity): boolean {
    return sameIdentity(this.config().owner, k);
  }
  isAgentKey(k: Identity): boolean {
    return sameIdentity(this.config().agent, k);
  }

  // ---- files ------------------------------------------------------------------------

  private writeJson(file: string, value: unknown) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private threadFile(id: string) {
    if (!THREAD_ID.test(id)) throw new VaultError("Invalid conversation id");
    return path.join(this.dir, `${id}.json`);
  }

  private threadIds(): string[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => THREAD_FILE.exec(f)?.[1])
      .filter((x): x is string => !!x);
  }

  getThread(id: string): ChatThread {
    const f = this.threadFile(id);
    if (!fs.existsSync(f)) throw new VaultError("That conversation doesn't exist");
    return JSON.parse(fs.readFileSync(f, "utf8")) as ChatThread;
  }

  private save(t: ChatThread) {
    this.writeJson(this.threadFile(t.id), t);
  }

  private summary(t: ChatThread): ThreadSummary {
    const agentMsgs = t.messages.filter((m) => m.author === "agent");
    return {
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      count: t.messages.length,
      queued: t.messages.filter((m) => m.author === "owner" && m.state === "queued").length,
      lastAgentAt: agentMsgs.length ? agentMsgs[agentMsgs.length - 1].at : null,
    };
  }

  listThreads(): ThreadSummary[] {
    return this.threadIds()
      .map((id) => this.summary(this.getThread(id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Cheap change marker for the UI's poll: changes whenever any conversation or the channel changes. */
  fingerprint(): string {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f + ":" + fs.statSync(path.join(this.dir, f)).mtimeMs)
      .sort()
      .join("|");
  }

  /** Messages the agent hasn't picked up, and when it last asked. */
  status(): { queued: number; lastAgentSeen: string | null } {
    return { queued: this.listThreads().reduce((n, t) => n + t.queued, 0), lastAgentSeen: this.config().lastAgentSeen };
  }

  /** Sortable ids: time, then a counter (so two messages in one millisecond keep their order), then randomness. */
  private id(prefix: string) {
    seq = (seq + 1) % 1_679_616;
    return `${prefix}${this.now().toString(36).padStart(9, "0")}${seq.toString(36).padStart(4, "0")}${crypto.randomBytes(2).toString("hex")}`;
  }

  private clean(body: unknown): string {
    if (typeof body !== "string") throw new VaultError("A message needs text");
    const b = body.replace(/\r\n?/g, "\n").trim();
    if (!b) throw new VaultError("A message needs text");
    if (b.length > MAX_BODY_CHARS) throw new VaultError(`A message can be at most ${MAX_BODY_CHARS.toLocaleString()} characters`);
    return b;
  }

  // ---- the owner's side ------------------------------------------------------------

  /** The owner sends a message (starting a conversation if `threadId` is null). It waits as `queued`. */
  send(threadId: string | null, body: unknown, context: ChatRef[] = []): { thread: ThreadSummary; message: ChatMessage } {
    const text = this.clean(body);
    const at = iso(this.now());
    let t: ChatThread;
    if (threadId) {
      t = this.getThread(threadId);
      if (t.messages.length >= MAX_THREAD_MESSAGES) throw new VaultError("This conversation is full. Start a new one");
    } else {
      if (this.threadIds().length >= MAX_THREADS) throw new VaultError("Too many conversations. Delete some first");
      const first = text.split("\n")[0].replace(/\s+/g, " ").trim();
      t = {
        id: `${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`,
        title: first.length > 60 ? first.slice(0, 59) + "…" : first,
        createdAt: at,
        updatedAt: at,
        messages: [],
      };
    }
    const message: ChatMessage = { id: this.id("o"), author: "owner", at, body: text, state: "queued", context: context.slice(0, CONTEXT_MATCHES + 1) };
    t.messages.push(message);
    t.updatedAt = at;
    this.save(t);
    return { thread: this.summary(t), message };
  }

  deleteThread(id: string) {
    const f = this.threadFile(id);
    if (!fs.existsSync(f)) throw new VaultError("That conversation doesn't exist");
    fs.rmSync(f);
  }

  // ---- the agent's side ------------------------------------------------------------

  /**
   * The agent asks for what is waiting: oldest first, up to `limit`. Each message is marked delivered,
   * and carries a little earlier conversation so it can be answered on its own. Asking also records
   * when the agent last picked up, whether or not anything was waiting.
   */
  fetchQueued(limit: number, excerpt: (ref: ChatRef) => string = () => ""): {
    messages: { thread: string; thread_title: string; id: string; at: string; body: string; context: (ChatRef & { excerpt: string })[]; history: { author: ChatAuthor; at: string; body: string }[] }[];
    remaining: number;
  } {
    const at = iso(this.now());
    const c = this.config();
    c.lastAgentSeen = at;
    this.saveConfig(c);
    const queued: { t: ChatThread; m: ChatMessage }[] = [];
    for (const id of this.threadIds()) {
      const t = this.getThread(id);
      for (const m of t.messages) if (m.author === "owner" && m.state === "queued") queued.push({ t, m });
    }
    queued.sort((a, b) => a.m.at.localeCompare(b.m.at) || a.m.id.localeCompare(b.m.id));
    const take = queued.slice(0, Math.max(1, Math.min(MAX_FETCH, limit)));
    const out = take.map(({ t, m }) => {
      const idx = t.messages.indexOf(m);
      return {
        thread: t.id,
        thread_title: t.title,
        id: m.id,
        at: m.at,
        body: m.body,
        context: (m.context ?? []).map((r) => ({ ...r, excerpt: excerpt(r) })),
        history: t.messages.slice(Math.max(0, idx - AGENT_HISTORY), idx).map((p) => ({ author: p.author, at: p.at, body: p.body })),
      };
    });
    const touched = new Map<string, ChatThread>();
    for (const { t, m } of take) {
      const fresh = touched.get(t.id) ?? this.getThread(t.id);
      const mm = fresh.messages.find((x) => x.id === m.id);
      if (mm) {
        mm.state = "delivered";
        mm.deliveredAt = at;
      }
      touched.set(t.id, fresh);
    }
    for (const t of touched.values()) this.save(t);
    return { messages: out, remaining: queued.length - take.length };
  }

  /**
   * The agent replies in a conversation. Everything it had fetched there is then `answered`.
   * `proposal` (optional) is one proposal id, checked by the caller, that goes with the reply.
   */
  reply(threadId: string, body: unknown, cites: ChatRef[] = [], proposal?: string): { thread: ThreadSummary; message: ChatMessage } {
    const text = this.clean(body);
    const t = this.getThread(threadId);
    if (t.messages.length >= MAX_THREAD_MESSAGES) throw new VaultError("This conversation is full");
    const at = iso(this.now());
    for (const m of t.messages) {
      if (m.author === "owner" && m.state === "delivered") {
        m.state = "answered";
        m.answeredAt = at;
      }
    }
    const message: ChatMessage = {
      id: this.id("a"),
      author: "agent",
      at,
      body: text,
      ...(cites.length ? { cites: cites.slice(0, MAX_CITES) } : {}),
      ...(proposal ? { proposal } : {}),
    };
    t.messages.push(message);
    t.updatedAt = at;
    this.save(t);
    return { thread: this.summary(t), message };
  }

  /** True if some chat message already carries this proposal. */
  proposalLinked(id: string): boolean {
    return this.threadIds().some((tid) => this.getThread(tid).messages.some((m) => m.proposal === id));
  }
}

// ---- notes that ride along with a message ---------------------------------------------

/** Title of a note, or null if it isn't a readable note. */
export function noteRef(vault: Vault, rel: string, why?: ChatRef["why"]): ChatRef | null {
  let r: string;
  try {
    r = vault.normalize(rel);
  } catch {
    return null;
  }
  if (r.split("/").some((s) => s.startsWith("."))) return null;
  if (!vault.exists(r)) return null;
  return { path: r, title: extractTitle(vault.read(r), r), ...(why ? { why } : {}) };
}

/**
 * What a sent message carries: the note the owner has open (if they chose to share it) and the best
 * matches for the message text (if they chose that), capped. This list is stored with the message,
 * shown as chips, and returned to the agent: one list, so what the owner sees is what was shared.
 */
export function buildContext(vault: Vault, index: Index, body: string, o: { open?: string | null; related?: boolean }): ChatRef[] {
  const out: ChatRef[] = [];
  const seen = new Set<string>();
  if (o.open) {
    const r = noteRef(vault, o.open, "open");
    if (r) {
      out.push(r);
      seen.add(r.path);
    }
  }
  if (o.related !== false) {
    let n = 0;
    for (const hit of index.related(body, CONTEXT_MATCHES + 1)) {
      if (n >= CONTEXT_MATCHES) break;
      if (seen.has(hit.path)) continue;
      out.push({ path: hit.path, title: hit.title, why: "match" });
      seen.add(hit.path);
      n++;
    }
  }
  return out;
}

/** The start of a shared note, for the agent (it can read_note the rest). */
export function noteExcerpt(vault: Vault, ref: ChatRef): string {
  try {
    const body = parseFrontmatter(vault.read(ref.path)).body.trim();
    return body.length > EXCERPT_CHARS ? body.slice(0, EXCERPT_CHARS) + "…" : body;
  } catch {
    return "";
  }
}

/** Notes an agent says it used, checked to exist (a made-up path is an error, not a dead chip). */
export function citeRefs(vault: Vault, paths: string[] | undefined): ChatRef[] {
  const out: ChatRef[] = [];
  for (const p of (paths ?? []).slice(0, MAX_CITES)) {
    const r = noteRef(vault, p);
    if (!r) throw new VaultError(`Can't cite ${p}: no such note`);
    if (!out.some((x) => x.path === r.path)) out.push(r);
  }
  return out;
}
