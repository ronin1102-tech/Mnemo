import path from "node:path";

const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export interface Frontmatter {
  title?: string;
  created?: string;
  tags: string[];
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
const cleanTag = (s: string) => unquote(s).replace(/^#/, "").trim().toLowerCase();

/** Split optional YAML frontmatter (title, created, tags) from the body. Unknown fields are ignored, never rewritten. */
export function parseFrontmatter(raw: string): { fm: Frontmatter; body: string; hasFrontmatter: boolean } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // a UTF-8 BOM must not hide the opening ---
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const fm: Frontmatter = { tags: [] };
  if (!m) return { fm, body: text, hasFrontmatter: false };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(title|created|tags)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === "title" && /^[>|][+-]?$/.test(val)) {
      // block scalar: the title is the indented lines that follow, folded onto one line
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      if (parts.length) fm.title = parts.join(" ");
    } else if (key === "title" && val) fm.title = unquote(val);
    else if (key === "created" && val) fm.created = unquote(val);
    else if (key === "tags") {
      let items: string[] = [];
      if (val.startsWith("[")) items = val.replace(/^\[|\]$/g, "").split(",");
      else if (val) items = val.split(/[,\s]+/);
      else while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, ""));
      fm.tags = items.map(cleanTag).filter(Boolean);
    }
  }
  return { fm, body: text.slice(m[0].length), hasFrontmatter: true };
}

/** Frontmatter `created` as epoch ms, or null if absent or unparseable. */
export function extractCreated(text: string): number | null {
  const c = parseFrontmatter(text).fm.created;
  if (!c) return null;
  const t = Date.parse(c);
  return Number.isNaN(t) ? null : t;
}

/** Frontmatter title, else first `# heading`, else the file name. */
export function extractTitle(text: string, rel: string): string {
  const { fm, body } = parseFrontmatter(text);
  if (fm.title) return fm.title;
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  return (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
}

/** Frontmatter tags plus inline #tags, lowercased and de-duplicated. */
export function extractTags(text: string): string[] {
  const { fm, body } = parseFrontmatter(text);
  const out = new Set<string>(fm.tags);
  for (const m of body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Replace code (fenced blocks and inline spans) with spaces, keeping every offset and newline.
 * Links inside code are text, not links: they are neither edges nor rewritten on move.
 */
export function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const lines = text.split("\n");
  let fence: { ch: string; len: number } | null = null;
  const out = lines.map((line) => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      return blank(line);
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      return blank(line);
    }
    return line;
  });
  return out.join("\n").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => blank(span));
}

/** Apply `fn` to each regex match found outside code; matches that touch code are left alone. */
export function replaceOutsideCode(text: string, re: RegExp, fn: (m: RegExpMatchArray) => string): string {
  const masked = maskCode(text);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(re)) {
    const at = m.index as number;
    const orig = text.slice(at, at + m[0].length);
    if (orig !== m[0]) continue; // spans a code region
    out += text.slice(last, at) + fn(m);
    last = at + m[0].length;
  }
  return out + text.slice(last);
}

export interface RawLink {
  /** Wikilink: the written target. Markdown link: the vault-relative path it points at. */
  target: string;
  kind: "w" | "m";
  /** The line the link sits on, for backlink context. */
  context: string;
}

/** Normalise a markdown href relative to the note it is written in; null if external or outside the vault. */
export function mdTarget(href: string, srcRel: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let h = href.split("#")[0];
  try {
    h = decodeURIComponent(h);
  } catch {
    /* keep raw */
  }
  if (!/\.md$/i.test(h)) return null;
  const joined = h.startsWith("/") ? path.posix.normalize(h.slice(1)) : path.posix.join(path.posix.dirname(srcRel), h);
  return joined.startsWith("..") || joined.startsWith("/") ? null : joined;
}

/** All edges out of a note: `[[wikilinks]]` and relative `[text](note.md)` links. */
export function extractLinks(body: string, srcRel: string): RawLink[] {
  const out: RawLink[] = [];
  const seen = new Set<string>();
  const origLines = body.split("\n");
  const masked = maskCode(body).split("\n");
  for (let li = 0; li < masked.length; li++) {
    const line = masked[li];
    const ctx = origLines[li].trim().slice(0, 200);
    for (const m of line.matchAll(WIKILINK)) {
      const target = m[1].split("|")[0].split("#")[0].trim();
      if (target && !seen.has("w" + target)) {
        seen.add("w" + target);
        out.push({ target, kind: "w", context: ctx });
      }
    }
    for (const m of line.matchAll(MDLINK)) {
      const target = mdTarget(m[1], srcRel);
      if (target && !seen.has("m" + target)) {
        seen.add("m" + target);
        out.push({ target, kind: "m", context: ctx });
      }
    }
  }
  return out;
}

/**
 * Resolve link targets against known note paths. Wikilinks: exact path, then basename
 * (shortest-path-first on ties). Markdown links ("m"): exact path only.
 */
export function makeResolver(paths: string[]) {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const noExt = p.replace(/\.md$/i, "").toLowerCase();
    byPath.set(noExt, p);
    const base = noExt.split("/").pop() as string;
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  return (target: string, kind: "w" | "m" = "w"): string | null => {
    const t = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = byPath.get(t);
    if (exact || kind === "m") return exact ?? null;
    const cands = byBase.get(t.split("/").pop() as string);
    return cands ? (cands.length === 1 ? cands[0] : cands.sort()[0]) : null;
  };
}

/**
 * Rewrite links in `body` (the note at `srcRel`) that point at `from` so they point at `to`
 * after a move. Wikilinks keep aliases/#headings and are left alone if they still resolve;
 * relative markdown links are recomputed from the note's own directory.
 */
export function rewriteLinks(body: string, paths: string[], srcRel: string, from: string, to: string): string {
  const before = makeResolver(paths);
  const after = makeResolver(paths.filter((p) => p !== from).concat(to));
  const toNoExt = to.replace(/\.md$/i, "");
  let out = replaceOutsideCode(body, WIKILINK, (m) => {
    const whole = m[0];
    const mm = m[1].match(/^([^|#]*)(.*)$/s) as RegExpMatchArray;
    const target = mm[1].trim();
    if (!target || before(target) !== from || after(target) === to) return whole;
    const hadExt = /\.md$/i.test(target);
    let next = target.includes("/") ? toNoExt : toNoExt.split("/").pop()!;
    if (after(next) !== to) next = toNoExt;
    return `[[${next}${hadExt ? ".md" : ""}${mm[2]}]]`;
  });
  out = replaceOutsideCode(out, MDLINK, (m) => {
    const whole = m[0];
    const href = m[1];
    const target = mdTarget(href, srcRel);
    // same case-insensitive path match the index uses to resolve markdown links
    if (!target || before(target, "m") !== from) return whole;
    const frag = href.includes("#") ? "#" + href.split("#").slice(1).join("#") : "";
    let rel = path.posix.relative(path.posix.dirname(srcRel), to);
    if (!rel.startsWith(".") && href.startsWith("./")) rel = "./" + rel;
    if (href.startsWith("/")) rel = "/" + to;
    return whole.replace(href, (/%20/.test(href) ? rel.replace(/ /g, "%20") : rel) + frag);
  });
  return out;
}
