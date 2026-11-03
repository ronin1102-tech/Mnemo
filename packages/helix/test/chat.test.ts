import { agentLabel, hasUnseen, isNearBottom, newestAgentAt, relativeTime, savePath, stateLabel, statusLine, transcriptMarkdown } from "../src/chat";
import type { ChatThread } from "../src/types";
import { describe, expect, it } from "./expect";

const NOW = Date.parse("2026-11-03T12:00:00Z");

describe("copilot pane helpers", () => {
  it("labels the agent from its key name, and never claims it is live", () => {
    expect(agentLabel("cori")).toBe("Cori");
    expect(agentLabel(null)).toBe("The agent");
    expect(statusLine({ agent: "cori", lastAgentSeen: "2026-11-03T11:45:00Z", queued: 2 }, NOW)).toBe("Cori last picked up messages 15 min ago · 2 queued");
    expect(statusLine({ agent: "cori", lastAgentSeen: null, queued: 0 }, NOW)).toBe("Cori hasn't picked up messages yet");
    expect(statusLine({ agent: null, lastAgentSeen: null, queued: 0 })).toContain("mnemo-ctl chat setup");
    for (const s of [statusLine({ agent: "cori", lastAgentSeen: "2026-11-03T11:59:59Z", queued: 0 }, NOW)]) expect(s.toLowerCase()).not.toMatch(/online|typing|live/);
  });
  it("says plainly what happened to each message, without pronouns", () => {
    const m = { id: "1", author: "owner" as const, at: "x", body: "b" };
    expect(stateLabel({ ...m, state: "queued" }, "cori")).toBe("Queued: Cori will see this when next active");
    expect(stateLabel({ ...m, state: "delivered" }, "cori")).toBe("Delivered: Cori has read this");
    expect(stateLabel({ ...m, state: "answered" }, "cori")).toBe("Answered");
    expect(stateLabel({ ...m, author: "agent" as const }, "cori")).toBe("");
  });
  it("relative times", () => {
    expect(relativeTime("2026-11-03T11:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-11-03T09:00:00Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-11-01T12:00:00Z", NOW)).toBe("2 d ago");
    expect(relativeTime("2026-10-01T12:00:00Z", NOW)).toBe("2026-10-01");
  });
  it("the badge: new when the agent wrote after this device last looked", () => {
    const t = (lastAgentAt: string | null) => ({ id: "i", title: "t", createdAt: "", updatedAt: "", count: 1, queued: 0, lastAgentAt });
    const threads = [t("2026-11-03T10:00:00Z"), t(null), t("2026-11-03T11:00:00Z")];
    expect(newestAgentAt(threads)).toBe("2026-11-03T11:00:00Z");
    expect(hasUnseen(threads, null)).toBe(true);
    expect(hasUnseen(threads, "2026-11-03T10:30:00Z")).toBe(true);
    expect(hasUnseen(threads, "2026-11-03T11:00:00Z")).toBe(false);
    expect(hasUnseen([t(null)], null)).toBe(false);
  });
  it("follows the bottom only while already there", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(870, 100, 1000)).toBe(true); // within a touch
    expect(isNearBottom(500, 100, 1000)).toBe(false); // scrolled up: don't yank
  });
  it("turns a conversation into a note, with links for shared and cited notes", () => {
    const thread: ChatThread = {
      id: "i", title: "Cabin plans", createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:05:00Z",
      messages: [
        { id: "1", author: "owner", at: "2026-11-03T10:00:00Z", body: "When should I book?", state: "answered", context: [{ path: "Trips/Cabin.md", title: "Cabin", why: "open" }] },
        { id: "2", author: "agent", at: "2026-11-03T10:05:00Z", body: "In **June**.", cites: [{ path: "Trips/Cabin.md", title: "Cabin" }], proposal: "p1" },
      ],
    };
    const md = transcriptMarkdown(thread, { agent: "cori", proposals: { p1: { id: "p1", status: "approved", op: "write", path: "Summary.md" } }, date: "2026-11-03" });
    expect(md).toBe([
      "---", "created: 2026-11-03", "tags: [chat]", "---", "# Chat: Cabin plans", "", "Saved from the Copilot chat with Cori.", "",
      "**Me** · 2026-11-03 10:00", "", "When should I book?", "", "*Shared:* [[Trips/Cabin|Cabin]]", "",
      "**Cori** · 2026-11-03 10:05", "", "In **June**.", "", "*Notes used:* [[Trips/Cabin|Cabin]]", "", "*Proposal:* write Summary.md (approved)", "",
    ].join("\n"));
    expect(savePath("Cabin plans: June?", "2026-11-03")).toBe("Chats/Cabin plans June 2026-11-03.md");
    expect(savePath("Cabin plans", "2026-11-03", 3)).toBe("Chats/Cabin plans 2026-11-03 3.md");
    expect(savePath("///", "2026-11-03")).toBe("Chats/Conversation 2026-11-03.md");
  });
});
