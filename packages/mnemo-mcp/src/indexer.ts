import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Vault } from "./vault.js";
import { extractTags, extractTitle, extractWikilinks, makeResolver } from "./links.js";

export interface NoteMeta {
  path: string;
  title: string;
  mtime: number;
  tags: string[];
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT, mtime REAL, size INTEGER, tags TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body, tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS links(src TEXT, target TEXT, resolved TEXT);
      CREATE INDEX IF NOT EXISTS links_resolved ON links(resolved);
    `);
  }

  close() {
    this.db.close();
  }

  /** Bring the index in line with disk. Cheap when nothing changed (stat only). */
  sync(): void {
    const files = this.vault.listAll();
    const known = new Map(
      (this.db.prepare("SELECT path, mtime, size FROM notes").all() as { path: string; mtime: number; size: number }[]).map(
        (r) => [r.path, r],
      ),
    );
    const fileSet = new Set(files);
    let changed = false;

    const del = this.db.transaction((p: string) => {
      this.db.prepare("DELETE FROM notes WHERE path=?").run(p);
      this.db.prepare("DELETE FROM notes_fts WHERE path=?").run(p);
      this.db.prepare("DELETE FROM links WHERE src=?").run(p);
    });
    for (const p of known.keys()) {
      if (!fileSet.has(p)) {
        del(p);
        changed = true;
      }
    }

    const upsert = this.db.transaction((rel: string, st: fs.Stats, body: string) => {
      del(rel);
      const tags = extractTags(body);
      this.db
        .prepare("INSERT INTO notes(path,title,mtime,size,tags) VALUES(?,?,?,?,?)")
        .run(rel, extractTitle(body, rel), st.mtimeMs, st.size, tags.join(","));
      this.db.prepare("INSERT INTO notes_fts(path,title,body) VALUES(?,?,?)").run(rel, extractTitle(body, rel), body);
      const ins = this.db.prepare("INSERT INTO links(src,target,resolved) VALUES(?,?,NULL)");
      for (const t of extractWikilinks(body)) ins.run(rel, t);
    });
    for (const rel of files) {
      const abs = path.join(this.vault.root, ...rel.split("/"));
      const st = fs.statSync(abs);
      const k = known.get(rel);
      if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
      upsert(rel, st, fs.readFileSync(abs, "utf8"));
      changed = true;
    }

    if (changed) {
      const resolve = makeResolver(files);
      const rows = this.db.prepare("SELECT rowid, target FROM links").all() as { rowid: number; target: string }[];
      const upd = this.db.prepare("UPDATE links SET resolved=? WHERE rowid=?");
      this.db.transaction(() => {
        for (const r of rows) upd.run(resolve(r.target), r.rowid);
      })();
    }
  }

  private meta(r: { path: string; title: string; mtime: number; tags: string }): NoteMeta {
    return { path: r.path, title: r.title, mtime: r.mtime, tags: r.tags ? r.tags.split(",") : [] };
  }

  search(query: string, limit = 10): SearchHit[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu);
    if (!terms) return [];
    const match = terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
    const rows = this.db
      .prepare(
        `SELECT n.path, n.title, n.mtime, n.tags, snippet(notes_fts, 2, '[', ']', '…', 12) AS snippet
         FROM notes_fts JOIN notes n ON n.path = notes_fts.path
         WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 0.0, 5.0, 1.0) LIMIT ?`,
      )
      .all(match, limit) as any[];
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

  backlinks(rel: string): NoteMeta[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT n.* FROM links l JOIN notes n ON n.path = l.src
           WHERE l.resolved = ? AND l.src != ? ORDER BY n.mtime DESC`,
        )
        .all(rel, rel) as any[]
    ).map((r) => this.meta(r));
  }

  /** Whole-vault graph for the Helix UI. */
  graph() {
    const nodes = (this.db.prepare("SELECT * FROM notes ORDER BY mtime").all() as any[]).map((r) => this.meta(r));
    const links = this.db
      .prepare("SELECT DISTINCT src, resolved AS dst FROM links WHERE resolved IS NOT NULL AND resolved != src")
      .all() as { src: string; dst: string }[];
    return { nodes, links };
  }
}
