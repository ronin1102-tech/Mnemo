/** Pure helpers for the Copilot pane. Kept free of DOM so they can be unit-tested. */
import { fileNameFromTitle } from "./owner";
import type { ChatList, ChatMessage, ChatProposal, ChatThread, ChatThreadSummary } from "./types";

/** "cori" -> "Cori". The name comes from the key the owner connected; the pane shows it as the agent's label. */
export function agentLabel(name: string | null): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "The agent";
}

const MIN = 60_000;
export function relativeTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!(ms >= 0) || ms < MIN) return "just now";
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < 24 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))} h ago`;
  if (ms < 7 * 24 * 60 * MIN) return `${Math.floor(ms / (24 * 60 * MIN))} d ago`;
  return iso.slice(0, 10);
}

/**
 * The status line. Honest about asynchrony: it says when the agent last picked up messages, never that
 * it is "online" or "typing".
 */
export function statusLine(list: Pick<ChatList, "agent" | "lastAgentSeen" | "queued">, now: number = Date.now()): string {
  if (!list.agent) return "No agent is connected to this chat yet. On the vault's computer: mnemo-ctl chat setup <your key> <agent key>";
  const who = agentLabel(list.agent);
  const seen = list.lastAgentSeen ? `${who} last picked up messages ${relativeTime(list.lastAgentSeen, now)}` : `${who} hasn't picked up messages yet`;
  return list.queued ? `${seen} · ${list.queued} queued` : seen;
}

/** Under each of the owner's messages. */
export function stateLabel(m: ChatMessage, agent: string | null): string {
  const who = agentLabel(agent);
  switch (m.state) {
    case "queued":
      return `Queued: ${who} will see this when next active`;
    case "delivered":
      return `Delivered: ${who} has read this`;
    case "answered":
      return "Answered";
    default:
      return "";
  }
}

/** The newest time the agent wrote anywhere, or null. */
export function newestAgentAt(threads: ChatThreadSummary[]): string | null {
  let best: string | null = null;
  for (const t of threads) if (t.lastAgentAt && (!best || t.lastAgentAt > best)) best = t.lastAgentAt;
  return best;
}

/** Has the agent written something since this device last had the pane open? */
export function hasUnseen(threads: ChatThreadSummary[], seen: string | null): boolean {
  const newest = newestAgentAt(threads);
  return !!newest && (!seen || newest > seen);
}

/** True when the view is at (or within a touch of) the bottom, so new messages should be followed. */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 48): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");
const link = (r: { path: string; title: string }) => `[[${r.path.replace(/\.md$/i, "")}|${r.title.replace(/[\]|]/g, " ")}]]`;

/**
 * "Save to vault": the conversation as a note. The owner's words are the owner's note (it is written
 * with their own key, through the normal note write). Shared notes and cited notes become wikilinks.
 */
export function transcriptMarkdown(t: ChatThread, o: { agent: string | null; proposals: Record<string, ChatProposal>; date: string }): string {
  const who = agentLabel(o.agent);
  const lines = ["---", `created: ${o.date}`, "tags: [chat]", "---", `# Chat: ${t.title}`, "", `Saved from the Copilot chat with ${who}.`, ""];
  for (const m of t.messages) {
    lines.push(`**${m.author === "owner" ? "Me" : who}** · ${stamp(m.at)}`, "", m.body, "");
    if (m.context && m.context.length) lines.push(`*Shared:* ${m.context.map(link).join(", ")}`, "");
    if (m.cites && m.cites.length) lines.push(`*Notes used:* ${m.cites.map(link).join(", ")}`, "");
    if (m.proposal) {
      const p = o.proposals[m.proposal];
      lines.push(`*Proposal:* ${p ? `${p.op ?? "change"} ${p.to ?? p.path ?? ""} (${p.status})` : m.proposal}`, "");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Where a saved conversation goes: `Chats/<title> <date>.md`. */
export function savePath(title: string, date: string, attempt = 1): string {
  const name = fileNameFromTitle(title) || "Conversation";
  return `Chats/${name} ${date}${attempt > 1 ? ` ${attempt}` : ""}.md`;
}
