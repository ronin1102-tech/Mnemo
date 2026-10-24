import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Vault } from "./vault.js";
import { extractCreated, extractLinks, extractTags, extractTitle, makeResolver, parseFrontmatter } from "./links.js";

interface KnownNote {
  id: number;
  mtime: number;
  size: number;
}
export interface NoteMeta {
  path: string;
  title: string;
  mtime: number;
  tags: string[];
  /** Frontmatter `created` (epoch ms) when present. */
  created: number | null;
}
export interface SearchHit extends NoteMeta {
  snippet: string;
}

/** SQLite FTS5 index stored in .mnemo/index.db. It is a cache: delete it and it rebuilds. */
export class Index {
  private db: Database.Database;

  constructor(private vault: Vault) {
    this.db = new Database(path.join(vault.ensureState(), "index.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL"); // the index is a rebuildable cache
    this.db.pragma("cache_size = -4096");
    // Schema v4: FTS rowid == notes.id so updates never scan the FTS table.
    if ((this.db.pragma("user_version", { simple: true }) as number) !== 4) {
      this.db.exec("DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS links;");
      this.db.pragma("user_version = 4");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, path TEXT UNIQUE, title TEXT, mtime REAL, size INTEGER, tags TEXT, created REAL);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS links(src TEXT, target TEXT, kind TEXT, ctx TEXT, resolved TEXT);
      CREATE INDEX IF NOT EXISTS links_src ON links(src);
      CREATE INDEX IF NOT EXISTS links_resolved ON links(resolved);
    `);
  }

  close() {
    this.db.close();
  }

  private knownCache: Map<string, KnownNote> | null = null;
  private dataVersion = -1;

  /**
   * path -> row, cached across calls: re-reading 10k rows per tool call costs memory and time.
   * SQLite's data_version changes when ANOTHER connection commits (e.g. `mnemo-ctl reindex`).
   */
  private loadKnown(): Map<string, KnownNote> {
    const v = this.db.pragma("data_version", { simple: true }) as number;
    if (!this.knownCache || v !== this.dataVersion) {
      this.knownCache = new Map(
        (this.db.prepare("SELECT id, path, mtime, size FROM notes").all() as (KnownNote & { path: string })[]).map((r) => [r.path, r]),
      );
      this.dataVersion = v;
    }
    return this.knownCache;
  }

  /** Bring the index in line with disk. Cheap when nothing changed (stat only). Returns true if anything changed. */
  sync(): boolean {
    const files = this.vault.listAll();
    const known = this.loadKnown();
    const fileSet = new Set(files);
    const stale: string[] = [];
    for (const p of known.keys()) if (!fileSet.has(p)) stale.push(p);
    const changed: { rel: string; st: fs.Stats }[] = [];
    for (const rel of files) {
      const st = fs.statSync(path.join(this.vault.root, ...rel.split("/")));
      const k = known.get(rel);
      if (!k || k.mtime !== st.mtimeMs || k.size !== st.size) changed.push({ rel, st });
    }
    if (!stale.length && !changed.length) return false;

    const wasKnown = new Set(changed.filter((c) => known.has(c.rel)).map((c) => c.rel));
    const delFts = this.db.prepare("DELETE FROM notes_fts WHERE rowid=?");
    const delNote = this.db.prepare("DELETE FROM notes WHERE id=?");
    const delLinks = this.db.prepare("DELETE FROM links WHERE src=?");
    const insNote = this.db.prepare("INSERT INTO notes(path,title,mtime,size,tags,created) VALUES(?,?,?,?,?,?)");
    const insFts = this.db.prepare("INSERT INTO notes_fts(rowid,title,tags,body) VALUES(?,?,?,?)");
    const insLink = this.db.prepare("INSERT INTO links(src,target,kind,ctx,resolved) VALUES(?,?,?,?,NULL)");
    const drop = (rel: string) => {
      const k = known.get(rel);
      if (!k) return;
      known.delete(rel);
      delFts.run(k.id);
      delNote.run(k.id);
      delLinks.run(rel);
    };

    this.db.transaction(() => {
      for (const p of stale) drop(p);
      for (const { rel, st } of changed) {
        drop(rel);
        const body = fs.readFileSync(path.join(this.vault.root, ...rel.split("/")), "utf8");
        const title = extractTitle(body, rel);
        const tags = extractTags(body);
        const id = insNote.run(rel, title, st.mtimeMs, st.size, tags.join(","), extractCreated(body)).lastInsertRowid as number;
        known.set(rel, { id, mtime: st.mtimeMs, size: st.size });
        insFts.run(id, title, tags.join(" "), parseFrontmatter(body).body);
        for (const l of extractLinks(parseFrontmatter(body).body, rel)) insLink.run(rel, l.target, l.kind, l.context);
      }
      // Resolution depends on the whole set of paths, so redo all links only when that set changed.
      const pathsChanged = stale.length > 0 || changed.some((c) => !wasKnown.has(c.rel));
      const resolve = makeResolver(files);
      const rows = (
        pathsChanged
          ? this.db.prepare("SELECT rowid, target, kind FROM links").all()
          : changed.flatMap((c) => this.db.prepare("SELECT rowid, target, kind FROM links WHERE src=?").all(c.rel))
      ) as { rowid: number; target: string; kind: "w" | "m" }[];
      const upd = this.db.prepare("UPDATE links SET resolved=? WHERE rowid=?");
      for (const r of rows) upd.run(resolve(r.target, r.kind), r.rowid);
    })();
    this.dataVersion = this.db.pragma("data_version", { simple: true }) as number;
    return true;
  }

  private meta(r: { path: string; title: string; mtime: number; tags: string; created?: number | null }): NoteMeta {
    return { path: r.path, title: r.title, mtime: r.mtime, tags: r.tags ? r.tags.split(",") : [], created: r.created ?? null };
  }

  search(query: string, limit = 10, f: { folder?: string; tag?: string; after?: number; before?: number } = {}): SearchHit[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu);
    if (!terms) return [];
    const match = terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
    const esc = (x: string) => x.replace(/[\\%_]/g, "\\$&");
    const where = ["notes_fts MATCH ?"];
    const args: (string | number)[] = [match];
    if (f.folder) {
      where.push("n.path LIKE ? ESCAPE '\\'");
      args.push(esc(f.folder.replace(/^\/+|\/+$/g, "")) + "/%");
    }
    if (f.tag) {
      where.push("(',' || n.tags || ',') LIKE ? ESCAPE '\\'");
      args.push(`%,${esc(f.tag.replace(/^#/, "").toLowerCase())},%`);
    }
    if (f.after !== undefined) { where.push("COALESCE(n.created, n.mtime) >= ?"); args.push(f.after); }
    if (f.before !== undefined) { where.push("COALESCE(n.created, n.mtime) <= ?"); args.push(f.before); }
    const rows = this.db
      .prepare(
        `SELECT n.path, n.title, n.mtime, n.tags, n.created, snippet(notes_fts, 2, '[', ']', '…', 12) AS snippet
         FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
         WHERE ${where.join(" AND ")} ORDER BY bm25(notes_fts, 5.0, 3.0, 1.0) LIMIT ?`,
      )
      .all(...args, limit) as any[];
    return rows.map((r) => ({ ...this.meta(r), snippet: r.snippet }));
  }

  recent(limit = 10): NoteMeta[] {
    return (this.db.prepare("SELECT * FROM notes ORDER BY mtime DESC LIMIT ?").all(limit) as any[]).map((r) => this.meta(r));
  }

  list(folder = "", limit = 200, offset = 0): NoteMeta[] {
    const prefix = folder.replace(/^\/+|\/+$/g, "");
    const like = prefix ? prefix.replace(/[\\%_]/g, "\\$&") + "/%" : "%";
    return (
      this.db
        .prepare("SELECT * FROM notes WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ? OFFSET ?")
        .all(like, limit, offset) as any[]
    ).map((r) => this.meta(r));
  }

  /** Notes linking here, each with the line the (first) link sits on. */
  backlinks(rel: string): (NoteMeta & { context: string })[] {
    return (
      this.db
        .prepare(
          `SELECT n.*, (SELECT ctx FROM links l2 WHERE l2.src = n.path AND l2.resolved = ? LIMIT 1) AS context
           FROM notes n WHERE n.path IN (SELECT DISTINCT src FROM links WHERE resolved = ? AND src != ?) ORDER BY n.mtime DESC`,
        )
        .all(rel, rel, rel) as any[]
    ).map((r) => ({ ...this.meta(r), context: r.context ?? "" }));
  }

  /** Immediate sub-folders of `folder` with the number of notes under each. */
  folders(folder = ""): { name: string; count: number }[] {
    const prefix = folder.replace(/^\/+|\/+$/g, "");
    const like = prefix ? prefix.replace(/[\\%_]/g, "\\$&") + "/%" : "%";
    const counts = new Map<string, number>();
    for (const r of this.db.prepare("SELECT path FROM notes WHERE path LIKE ? ESCAPE '\\'").all(like) as { path: string }[]) {
      const rest = prefix ? r.path.slice(prefix.length + 1) : r.path;
      const i = rest.indexOf("/");
      if (i > 0) counts.set(rest.slice(0, i), (counts.get(rest.slice(0, i)) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whole-vault graph for the Helix UI. */
  graph() {
    const nodes = (this.db.prepare("SELECT * FROM notes ORDER BY mtime").all() as any[]).map((r) => this.meta(r));
    const links = this.db
      .prepare("SELECT DISTINCT src, resolved AS dst FROM links WHERE resolved IS NOT NULL AND resolved != src")
      .all() as { src: string; dst: string }[];
    return { nodes, links };
  }

  private outgoing(rel: string): string[] {
    return (this.db.prepare("SELECT DISTINCT resolved AS p FROM links WHERE src=? AND resolved IS NOT NULL AND resolved != ?").all(rel, rel) as { p: string }[]).map((r) => r.p);
  }

  private incoming(rel: string): string[] {
    return (this.db.prepare("SELECT DISTINCT src AS p FROM links WHERE resolved=? AND src != ?").all(rel, rel) as { p: string }[]).map((r) => r.p);
  }

  private metaOf(rel: string): NoteMeta | null {
    const r = this.db.prepare("SELECT * FROM notes WHERE path=?").get(rel) as any;
    return r ? this.meta(r) : null;
  }

  /** Link neighbourhood up to `depth` hops (links followed in both directions). */
  neighbors(rel: string, depth = 1) {
    if (!this.metaOf(rel)) return null;
    const dist = new Map<string, number>([[rel, 0]]);
    const edges = new Set<string>();
    let frontier = [rel];
    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const o of this.outgoing(n)) {
          edges.add(`${n}\u0000${o}`);
          if (!dist.has(o)) { dist.set(o, d); next.push(o); }
        }
        for (const i of this.incoming(n)) {
          edges.add(`${i}\u0000${n}`);
          if (!dist.has(i)) { dist.set(i, d); next.push(i); }
        }
      }
      frontier = next;
    }
    const unresolved = (this.db.prepare("SELECT DISTINCT target FROM links WHERE src=? AND resolved IS NULL").all(rel) as { target: string }[]).map((r) => r.target);
    return {
      path: rel,
      outgoing: this.outgoing(rel).map((p) => this.metaOf(p)!),
      incoming: this.incoming(rel).map((p) => this.metaOf(p)!),
      unresolved,
      /** Notes not linked to this one but sharing links or tags with it (same scoring as find_similar). */
      related: (this.similar(rel, 10) ?? []).filter((r) => !this.outgoing(rel).includes(r.path) && !this.incoming(rel).includes(r.path)),
      nodes: [...dist].filter(([p]) => p !== rel).map(([p, d]) => ({ ...this.metaOf(p)!, distance: d })),
      edges: [...edges].map((e) => { const [src, dst] = e.split("\u0000"); return { src, dst }; }),
    };
  }

  /** All tags with note counts, or the notes carrying one tag. */
  tags(tag?: string) {
    const rows = this.db.prepare("SELECT * FROM notes WHERE tags != ''").all() as any[];
    if (tag) {
      const t = tag.replace(/^#/, "").toLowerCase();
      return rows.filter((r) => r.tags.split(",").includes(t)).map((r) => this.meta(r));
    }
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of r.tags.split(",")) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Structural similarity: no embeddings, only the shape of the vault. Combines
   * bibliographic coupling (same outgoing links), co-citation (same linkers),
   * shared tags, a direct link, and folder. Returns a 0..1 score with reasons.
   */
  similar(rel: string, limit = 10) {
    const self = this.metaOf(rel);
    if (!self) return null;
    const out = new Set(this.outgoing(rel));
    const inn = new Set(this.incoming(rel));
    const tags = new Set(self.tags);
    const cand = new Set<string>([...out, ...inn]);
    const q = (sql: string, list: string[]) => {
      if (!list.length) return;
      for (const r of this.db.prepare(sql.replace("?", list.map(() => "?").join(","))).all(...list) as { p: string }[]) cand.add(r.p);
    };
    q("SELECT DISTINCT src AS p FROM links WHERE resolved IN (?)", [...out]); // link to the same notes
    q("SELECT DISTINCT resolved AS p FROM links WHERE src IN (?) AND resolved IS NOT NULL", [...inn]); // linked from the same notes
    for (const t of tags) for (const m of this.tags(t) as NoteMeta[]) cand.add(m.path);
    cand.delete(rel);

    const jac = (a: Set<string>, b: Set<string>) => {
      const shared = [...a].filter((x) => b.has(x));
      return { shared, score: shared.length ? shared.length / (a.size + b.size - shared.length) : 0 };
    };
    const names = (xs: string[]) => xs.slice(0, 3).map((x) => this.metaOf(x)?.title ?? x).join(", ") + (xs.length > 3 ? ", …" : "");
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const results: { path: string; title: string; score: number; reasons: string[] }[] = [];
    for (const c of cand) {
      const m = this.metaOf(c);
      if (!m) continue;
      const reasons: string[] = [];
      const coup = jac(out, new Set(this.outgoing(c)));
      const cocite = jac(inn, new Set(this.incoming(c)));
      const tg = jac(tags, new Set(m.tags));
      const direct = out.has(c) || inn.has(c);
      const sameFolder = folder !== "" && c.startsWith(folder + "/");
      if (coup.shared.length) reasons.push(`links to the same ${coup.shared.length} note(s): ${names(coup.shared)}`);
      if (cocite.shared.length) reasons.push(`linked from the same ${cocite.shared.length} note(s): ${names(cocite.shared)}`);
      if (tg.shared.length) reasons.push(`shares tag(s): ${tg.shared.map((t) => "#" + t).join(" ")}`);
      if (direct) reasons.push(out.has(c) && inn.has(c) ? "links both ways" : out.has(c) ? "linked from this note" : "links to this note");
      if (sameFolder) reasons.push(`same folder: ${folder}/`);
      const score = 0.3 * coup.score + 0.3 * cocite.score + 0.2 * tg.score + 0.15 * (direct ? 1 : 0) + 0.05 * (sameFolder ? 1 : 0);
      if (score > 0) results.push({ path: c, title: m.title, score: Math.round(score * 1000) / 1000, reasons });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  /** Drop everything and rebuild from the markdown files. */
  reindex(): { notes: number; ms: number } {
    const t = Date.now();
    this.db.exec("DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links;");
    this.knownCache = null;
    this.sync();
    return { notes: (this.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, ms: Date.now() - t };
  }
}
