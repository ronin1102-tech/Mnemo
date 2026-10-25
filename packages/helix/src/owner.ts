/** Pure helpers for the owner's editor and requests. Kept free of DOM so they can be unit-tested. */

/** The owner's requests to agents live here (the server refuses agent proposals inside it). */
export const REQUESTS_DIR = "Requests";
export const isRequestPath = (p: string) => p.split("/")[0].toLowerCase() === REQUESTS_DIR.toLowerCase();

export type RequestStatus = "open" | "in-progress" | "addressed" | "closed";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open: no agent has answered yet",
  "in-progress": "In progress: an answer is waiting for you",
  addressed: "Addressed: you approved an answer",
  closed: "Closed",
};

/** A file name from a title: drop the characters files and links can't hold, keep everything else. */
export function fileNameFromTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
}

/** Where a new note goes: `folder/<title>.md`, or null if the title leaves nothing usable. */
export function newNotePath(title: string, folder = ""): string | null {
  const name = fileNameFromTitle(title);
  if (!name) return null;
  const dir = folder
    .split("/")
    .map((s) => fileNameFromTitle(s))
    .filter(Boolean)
    .join("/");
  return (dir ? dir + "/" : "") + name + ".md";
}

/** A new note's text: its title as the heading, then whatever was typed. */
export function newNoteContent(title: string, body: string): string {
  const b = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return `# ${title.trim()}\n` + (b ? `\n${b}\n` : "");
}
