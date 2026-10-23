const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;

/** Extract raw wikilink targets: `[[Target|alias]]`, `[[Target#Heading]]` -> `Target`. */
export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

export function extractTitle(body: string, rel: string): string {
  const h = body.match(/^#\s+(.+)$/m);
  if (h) return h[1].trim();
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.md$/i, "");
}

export function extractTags(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Resolve a wikilink target against known note paths: exact path, then unique basename. */
export function makeResolver(paths: string[]) {
  const byPath = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const noExt = p.replace(/\.md$/i, "").toLowerCase();
    byPath.set(noExt, p);
    const base = noExt.split("/").pop() as string;
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  return (target: string): string | null => {
    const t = target.replace(/\.md$/i, "").replace(/\\/g, "/").toLowerCase();
    const exact = byPath.get(t);
    if (exact) return exact;
    const cands = byBase.get(t.split("/").pop() as string);
    return cands && cands.length === 1 ? cands[0] : cands ? cands.sort()[0] : null;
  };
}
