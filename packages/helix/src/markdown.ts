/**
 * A small Markdown parser for the reader (Obsidian-flavoured: wikilinks, #tags, callouts, ==highlights==,
 * task lists, tables). It produces a plain data tree and never HTML: the reader builds DOM nodes from it
 * with textContent, so nothing in a note (agent-written or not) can inject markup or script.
 * Kept free of DOM so it can be unit-tested.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del" | "mark"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "wiki"; target: string; heading: string; label: string; embed: boolean }
  | { t: "image"; alt: string; src: string }
  | { t: "tag"; v: string }
  | { t: "br" };

export type Align = "left" | "center" | "right" | "";
export interface ListItem {
  /** null: not a task; true/false: checked or not. */
  task: boolean | null;
  c: Block[];
}
export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; c: Block[] }
  | { t: "callout"; kind: string; title: Inline[]; c: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** Split off a leading YAML frontmatter block. */
export function stripFrontmatter(src: string): { body: string; frontmatter: string | null } {
  const s = src.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(s);
  return m ? { body: s.slice(m[0].length), frontmatter: m[1] } : { body: s, frontmatter: null };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const lead = (l: string) => /^ */.exec(l)![0].length;
const isTableStart = (lines: string[], i: number) => lines[i].indexOf("|") >= 0 && i + 1 < lines.length && lines[i + 1].indexOf("-") >= 0 && TABLE_SEP.test(lines[i + 1]);
const isBlockStart = (lines: string[], i: number) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i);
};

export function parseBlocks(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE.exec(line);
    if (m) {
      const close = new RegExp("^ {0,3}" + (m[1][0] === "`" ? "`" : "~") + "{" + m[1].length + ",}[ \\t]*$");
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end of the note)
      out.push({ t: "code", lang: m[2], v: body.join("\n") });
      continue;
    }
    m = HEADING.exec(line);
    if (m) {
      out.push({ t: "h", level: m[1].length, c: parseInline(m[2] || "") });
      i++;
      continue;
    }
    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      const cm = /^\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/.exec(inner[0] || "");
      if (cm) {
        const kind = cm[1].toLowerCase();
        out.push({ t: "callout", kind, title: parseInline(cm[2] || kind.charAt(0).toUpperCase() + kind.slice(1)), c: blocks(inner.slice(1)) });
      } else out.push({ t: "quote", c: blocks(inner) });
      continue;
    }

    if (LIST.test(line)) {
      i = parseList(lines, i, out);
      continue;
    }

    if (isTableStart(lines, i)) {
      const align = cells(lines[i + 1]).map((c): Align => {
        const l = c.trim().startsWith(":"), r = c.trim().endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      const head = cells(lines[i]).map((c) => parseInline(c.trim()));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) rows.push(cells(lines[i++]).map((c) => parseInline(c.trim())));
      out.push({ t: "table", align, head, rows });
      continue;
    }

    // paragraph (with setext headings: a line of === or --- under it)
    const para: string[] = [line.trim()];
    i++;
    let setext = 0;
    while (i < lines.length && lines[i].trim()) {
      if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
      if (isBlockStart(lines, i)) break;
      para.push(lines[i++].trim());
    }
    const text = para.join("\n");
    out.push(setext ? { t: "h", level: setext, c: parseInline(text) } : { t: "p", c: parseInline(text) });
  }
  return out;
}

/** Table cells: split on unescaped pipes outside code, dropping the optional outer pipes. */
function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseList(lines: string[], i: number, out: Block[]): number {
  const first = LIST.exec(lines[i])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = indent + m[2].length + 1;
    const body: string[] = [m[3] || ""];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // a blank line continues the item only if indented content follows it
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && lead(lines[j]) > indent) {
          while (i < j) { body.push(""); i++; }
          continue;
        }
        break;
      }
      const ld = lead(l);
      if (ld > indent) { body.push(l.slice(Math.min(ld, contentIndent))); i++; continue; }
      if (!isBlockStart(lines, i) && body[body.length - 1].trim()) { body.push(l.trim()); i++; continue; } // lazy continuation
      break;
    }
    let task: boolean | null = null;
    const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]);
    if (tm) {
      task = tm[1] !== " ";
      body[0] = body[0].slice(tm[0].length);
    }
    items.push({ task, c: blocks(body) });
  }
  out.push({ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items });
  return i;
}

// ---- inline ------------------------------------------------------------------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~=<>]/;
const CODE_SPAN = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const WORD = /[\p{L}\p{N}]/u;
/** "(url)" or "(<url> "title")": the URL may hold one level of balanced parentheses (Wikipedia-style). */
const LINK_DEST = '\\(\\s*<?((?:[^()\\s<>]|\\([^()\\s]*\\))*)>?(?:\\s+"[^"]*")?\\s*\\)';
const DELIMS: [string, "strong" | "em" | "del" | "mark"][] = [["**", "strong"], ["__", "strong"], ["~~", "del"], ["==", "mark"], ["*", "em"], ["_", "em"]];

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === "\n") { flush(); out.push({ t: "br" }); i++; continue; }
    if (c === "`") {
      const m = CODE_SPAN.exec(rest);
      if (m) {
        flush();
        out.push({ t: "code", v: m[2].length > 2 && m[2][0] === " " && m[2][m[2].length - 1] === " " ? m[2].slice(1, -1) : m[2] });
        i += m[0].length;
        continue;
      }
      const run = /^`+/.exec(rest)![0];
      buf += run;
      i += run.length;
      continue;
    }
    if (rest.startsWith("[[") || rest.startsWith("![[")) {
      const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(rest);
      if (m) {
        flush();
        out.push(wiki(m[2], m[1] === "!"));
        i += m[0].length;
        continue;
      }
    }
    if (rest.startsWith("![")) {
      const m = new RegExp("^!\\[([^\\]\\n]*)\\]" + LINK_DEST).exec(rest);
      if (m) {
        flush();
        out.push({ t: "image", alt: m[1], src: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const close = matchBracket(s, i);
      if (close > 0 && s[close + 1] === "(") {
        const m = new RegExp("^" + LINK_DEST).exec(s.slice(close + 1));
        if (m) {
          flush();
          out.push({ t: "link", href: m[1], c: parseInline(s.slice(i + 1, close)) });
          i = close + 1 + m[0].length;
          continue;
        }
      }
    }
    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", href: m[1], c: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = /^https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"*_~]/i.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", href: m[0], c: [{ t: "text", v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "#" && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = /^#([\p{L}\p{N}_/-]+)/u.exec(rest);
      if (m && /[^\d]/.test(m[1])) {
        flush();
        out.push({ t: "tag", v: m[1] });
        i += m[0].length;
        continue;
      }
    }
    for (const [d, t] of DELIMS) {
      if (!rest.startsWith(d)) continue;
      const after = s[i + d.length];
      const intraword = d[0] === "_" && i > 0 && WORD.test(s[i - 1]);
      if (after && !/\s/.test(after) && !intraword) {
        const j = findClose(s, i + d.length, d); // at least one character inside
        if (j > 0) {
          flush();
          out.push({ t, c: parseInline(s.slice(i + d.length, j)) });
          i = j + d.length;
          continue outer;
        }
      }
      buf += d; // an unmatched delimiter is literal text
      i += d.length;
      continue outer;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function wiki(raw: string, embed: boolean): Inline {
  const bar = raw.search(/\\?\|/);
  const targetPart = bar >= 0 ? raw.slice(0, bar) : raw;
  const alias = bar >= 0 ? raw.slice(bar).replace(/^\\?\|/, "").trim() : "";
  const hash = targetPart.indexOf("#");
  const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
  const heading = hash >= 0 ? targetPart.slice(hash + 1).replace(/^\^/, "").trim() : "";
  const label = alias || (target ? target.replace(/\.md$/i, "").split("/").pop()! + (heading ? " › " + heading : "") : heading);
  return { t: "wiki", target, heading, label, embed };
}

/** Index of the "]" matching the "[" at `open`, or -1. */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "\n" && s[j + 1] === "\n") return -1;
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) return j;
  }
  return -1;
}

/** Where the emphasis opened with `d` closes, or -1. Skips code spans and escapes. */
function findClose(s: string, from: number, d: string): number {
  for (let j = from + 1; j <= s.length - d.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") {
      const m = CODE_SPAN.exec(s.slice(j));
      if (m) { j += m[0].length - 1; continue; }
    }
    if (!s.startsWith(d, j)) continue;
    if (d.length === 1 && s[j + 1] === d) { j++; continue; } // "**" inside "*…*" is a nested pair, not the close
    if (d.length === 2 && s[j + 2] === d[0]) continue; // "***": close on the last two
    if (/\s/.test(s[j - 1])) continue;
    if (d[0] === "_" && WORD.test(s[j + d.length] || "")) continue;
    return j;
  }
  return -1;
}

// ---- helpers for the reader ----------------------------------------------------------

/** Plain text of an inline run (for comparing a leading H1 with the title, slugs, and word counts). */
export function plainText(c: Inline[]): string {
  return c
    .map((n) => {
      switch (n.t) {
        case "text": case "code": return n.v;
        case "tag": return "#" + n.v;
        case "wiki": return n.label;
        case "image": return n.alt;
        case "br": return " ";
        default: return plainText(n.c);
      }
    })
    .join("");
}

export function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}

export function wordCount(src: string): number {
  const m = src.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/**
 * Resolve link targets against the vault's note paths, the way the server does: wikilinks by exact
 * path, then by basename (shortest path first on ties).
 */
export function makeResolver(paths: string[]) {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const noExt = p.replace(/\.md$/i, "").toLowerCase();
    byPath.set(noExt, p);
    const base = noExt.split("/").pop() as string;
    byBase.set(base, (byBase.get(base) || []).concat(p));
  }
  return (target: string): string | null => {
    const t = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = byPath.get(t);
    if (exact) return exact;
    const cands = byBase.get(t.split("/").pop() as string);
    return cands ? cands.slice().sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0] : null;
  };
}

export type Href = { kind: "note"; path: string; heading: string } | { kind: "web"; href: string } | { kind: "none" };

/**
 * What a Markdown link points at. Only http(s) and mailto leave the app; a relative .md link opens that
 * note in the reader; anything else (javascript:, file:, data:, …) is shown as plain text.
 */
export function classifyHref(href: string, srcPath: string, resolve: (t: string) => string | null): Href {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "web", href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { kind: "none" };
  let target = href;
  try { target = decodeURIComponent(href); } catch (_) { /* keep it raw */ }
  const hash = target.indexOf("#");
  const heading = hash >= 0 ? target.slice(hash + 1) : "";
  target = hash >= 0 ? target.slice(0, hash) : target;
  if (!target) return { kind: "none" };
  if (!/\.md$/i.test(target)) return { kind: "none" };
  const dir = srcPath.split("/").slice(0, -1);
  const parts = target.startsWith("/") ? [] : dir;
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return { kind: "none" }; parts.pop(); } else parts.push(seg);
  }
  const p = resolve(parts.join("/"));
  return p ? { kind: "note", path: p, heading } : { kind: "none" };
}
