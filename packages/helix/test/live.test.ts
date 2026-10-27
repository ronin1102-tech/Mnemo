import { describeProposal, diffLines, expiresLabel, keyFromInput, tokenFromHash } from "../src/live";
import { describe, expect, it } from "./expect";

describe("live mode helpers", () => {
  it("reads the session token only from a well-formed fragment", () => {
    expect(tokenFromHash("#token=abcdefghijklmnopqrstuvwxyz_-0123")).toBe("abcdefghijklmnopqrstuvwxyz_-0123");
    expect(tokenFromHash("#x=1&token=abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(tokenFromHash("#token=short")).toBe(null);
    expect(tokenFromHash("#token=<script>alert(1)</script>")).toBe(null);
    expect(tokenFromHash("")).toBe(null);
  });
  it("accepts a key as typed, pasted wrapped, or inside the whole link; refuses anything else", () => {
    const k = "mn_p_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    expect(keyFromInput(k)).toBe(k);
    expect(keyFromInput(`  ${k}\n`)).toBe(k);
    expect(keyFromInput("mn_p_abcdefghijklmnopqrstuv\nwxyz0123456789ABCD")).toBe(k);
    expect(keyFromInput(`http://onemoreizzysmbp.tail81e3a6.ts.net:7337/#token=${k}`)).toBe(k);
    expect(keyFromInput("")).toBe(null);
    expect(keyFromInput("short")).toBe(null);
    expect(keyFromInput("mn_p_" + "x".repeat(300))).toBe(null);
    expect(keyFromInput("mn_p_abcdefghijklmnop!@#$")).toBe(null);
    expect(keyFromInput("mn_p_abcdé\u0001fghijklmnopqrst")).toBe(null);
    expect(keyFromInput("http://host/#nothing")).toBe(null);
  });
  it("classifies diff lines", () => {
    expect(diffLines("  same\n- old\n+ new\nmove a.md -> b.md")).toEqual([
      { kind: "ctx", text: "same" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      { kind: "note", text: "move a.md -> b.md" },
    ]);
  });
  it("describes proposals in plain language, never hiding that delete is recoverable", () => {
    expect(describeProposal({ op: "write", path: "n.md", client: "claude", exists: false })).toBe("claude proposes a new note, n.md");
    expect(describeProposal({ op: "delete", path: "n.md", client: "unknown" })).toContain("trash");
    expect(describeProposal({ op: "move", path: "a.md", to: "b/a.md", client: "x" })).toContain("links follow");
  });
  it("expiry label", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    expect(expiresLabel("2026-10-29T12:00:00Z", now)).toBe("expires in 5 days");
    expect(expiresLabel("2026-10-24T05:00:00Z", now)).toBe("expires today");
    expect(expiresLabel("2026-10-23T00:00:00Z", now)).toBe("expired");
  });
});
