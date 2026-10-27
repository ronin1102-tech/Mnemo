/** Pure helpers for live mode (`mnemo-ctl ui`). Kept free of DOM so they can be unit-tested. */

/** The session token arrives in the URL fragment (`#token=...`), which browsers never send over the network. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{16,})/.exec(hash);
  return m ? m[1] : null;
}

/**
 * A key typed or pasted into the entry screen. Whitespace (a wrapped paste, a trailing newline) is
 * dropped, and pasting the whole `...#token=KEY` link works too. Returns null if it can't be a key,
 * so a stray character never reaches a request header.
 */
export function keyFromInput(input: string): string | null {
  const s = input.replace(/\s+/g, "");
  const hash = s.indexOf("#");
  if (hash >= 0) return tokenFromHash(s.slice(hash));
  return /^[A-Za-z0-9_-]{16,200}$/.test(s) ? s : null;
}

export type DiffKind = "add" | "del" | "ctx" | "note";

/** Classify the server's diff lines ("+ ", "- ", "  ", or headers / notices). */
export function diffLines(diff: string): { kind: DiffKind; text: string }[] {
  return diff.split("\n").map((l) => {
    if (l.startsWith("+ ")) return { kind: "add" as const, text: l.slice(2) };
    if (l.startsWith("- ")) return { kind: "del" as const, text: l.slice(2) };
    if (l.startsWith("  ")) return { kind: "ctx" as const, text: l.slice(2) };
    return { kind: "note" as const, text: l };
  });
}

/** Plain-language description of what the agent is asking for. */
export function describeProposal(p: { op: string; path: string; to?: string; client: string; exists?: boolean }): string {
  const who = p.client && p.client !== "unknown" ? p.client : "An agent";
  switch (p.op) {
    case "write":
      return p.exists === false ? `${who} proposes a new note, ${p.path}` : `${who} proposes to rewrite ${p.path}`;
    case "append":
      return `${who} proposes to add to ${p.path}`;
    case "patch":
      return `${who} proposes an edit to ${p.path}`;
    case "move":
      return `${who} proposes to move ${p.path} to ${p.to || "?"} (links follow)`;
    case "delete":
      return `${who} proposes to delete ${p.path} (it would go to the trash, not be destroyed)`;
    default:
      return `${who} proposes a change to ${p.path}`;
  }
}

/** "expires in 5 days" / "expires today" / "expired". */
export function expiresLabel(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return "";
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  return days >= 1 ? `expires in ${days} day${days === 1 ? "" : "s"}` : "expires today";
}
