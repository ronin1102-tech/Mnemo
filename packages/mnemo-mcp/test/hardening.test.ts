import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "./expect.js";
import { lineDiff } from "../src/diff.js";
import { extractLinks, maskCode, parseFrontmatter, rewriteLinks } from "../src/links.js";
import { ProposalStore } from "../src/proposals.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

const cli = path.resolve("dist", "cli.js"); // npm runs tests from the package directory

describe("F6: oversized requests are refused cleanly, never kill the server (real stdio)", () => {
  it("survives an 11 MiB request and a >10 MB note, and still accepts a big valid note", async () => {
    if (!fs.existsSync(cli)) throw new Error("run `npm run build` first: this test drives dist/cli.js");
    const root = tmpVault({ "a.md": "# A\nstill here" });
    const client = new Client({ name: "big", version: "1" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "--vault", root, "serve"] }));
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;

    // 11,000,001 chars: over the schema cap, and over the SDK's old 10 MiB buffer once on the wire
    const tooLong = await call("write_note", { path: "huge.md", content: "x".repeat(11_000_001) });
    expect(tooLong.isError).toBe(true);
    // fewer chars but more than 10 MB of UTF-8: passes the schema, refused by the app's byte cap
    const multibyte = await call("write_note", { path: "wide.md", content: "é".repeat(6_000_000) });
    expect(multibyte.isError).toBe(true);
    expect(multibyte.content[0].text).toMatch(/10MB/);
    // a valid note (5.5 MB) whose JSON-escaped request is ~11 MB, past the old transport limit
    const ok = await call("write_note", { path: "big.md", content: "\n".repeat(5_500_000) });
    expect(ok.isError).toBeFalsy();
    // the server is alive and unharmed
    expect((await call("read_note", { path: "a.md" })).content[0].text).toContain("still here");
    expect(fs.existsSync(path.join(root, "huge.md"))).toBe(false);
    await client.close();
  }, 60_000);
});

describe("lineDiff stays bounded", () => {
  it("peels common lines and still diffs normally", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
  });
  it("does not build a giant table for two large different notes", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: 20000 }, (_, i) => `new ${i}`).join("\n");
    const t = Date.now();
    const d = lineDiff(a, b);
    expect(Date.now() - t).toBeLessThan(1500);
    const lines = d.split("\n");
    expect(lines).toHaveLength(20001); // capped at 20,000 lines + the truncation notice
    expect(lines[0]).toBe("- old 0");
    expect(lines[20000]).toContain("20000 more line(s)");
  });
});

describe("F7: code is not links", () => {
  const body = [
    "real [r](old.md) and [[old]]",
    "```md",
    "fenced [f](old.md) and [[old]]",
    "```",
    "~~~",
    "tilde [t](old.md)",
    "~~~",
    "inline `[i](old.md)` and ``[[old]]`` done",
    "after [a](old.md)",
  ].join("\n");

  it("maskCode blanks fences and spans but keeps offsets", () => {
    const m = maskCode(body);
    expect(m.length).toBe(body.length);
    expect(m).not.toContain("fenced");
    expect(m).not.toContain("tilde");
    expect(m).toContain("real [r](old.md)");
    expect(m).toContain("after [a](old.md)");
  });
  it("links inside code are not edges", () => {
    const l = extractLinks(body, "n.md");
    expect(l.map((x) => `${x.kind}:${x.target}`).sort()).toEqual(["m:old.md", "w:old"]);
    expect(l.every((x) => x.context.startsWith("real") || x.context.startsWith("after"))).toBe(true);
  });
  it("move rewrites outside code only, for markdown and wikilinks", () => {
    const out = rewriteLinks(body, ["old.md", "n.md"], "n.md", "old.md", "new/renamed.md").split("\n");
    expect(out[0]).toBe("real [r](new/renamed.md) and [[renamed]]");
    expect(out[2]).toBe("fenced [f](old.md) and [[old]]");
    expect(out[5]).toBe("tilde [t](old.md)");
    expect(out[7]).toBe("inline `[i](old.md)` and ``[[old]]`` done");
    expect(out[8]).toBe("after [a](new/renamed.md)");
  });
  it("an unclosed fence protects everything after it", () => {
    const out = rewriteLinks("[a](old.md)\n```\n[b](old.md)\n[[old]]", ["old.md", "n.md"], "n.md", "old.md", "z.md");
    expect(out).toBe("[a](z.md)\n```\n[b](old.md)\n[[old]]");
  });
  it("through a real move proposal", () => {
    const root = tmpVault({ "old.md": "# Old", "n.md": body });
    const store = new ProposalStore(new Vault(root));
    store.approve(store.proposeMove("old.md", "z.md", "c").id);
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toContain("fenced [f](old.md) and [[old]]");
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toContain("real [r](z.md)");
  });
});

describe("F8: case-variant markdown links are rewritten on move", () => {
  it("matches the index's case-insensitive resolution", () => {
    const out = rewriteLinks("[a](Old.md) [b](OLD.MD) [c](sub/../old.md) [d](other.md)", ["old.md", "n.md", "other.md"], "n.md", "old.md", "x/new.md");
    expect(out).toBe("[a](x/new.md) [b](x/new.md) [c](x/new.md) [d](other.md)");
  });
});

describe("F1 residuals", () => {
  it("a UTF-8 BOM does not hide frontmatter", () => {
    const { fm, hasFrontmatter, body } = parseFrontmatter("﻿---\ntitle: With BOM\ntags: [a]\n---\nbody");
    expect(hasFrontmatter).toBe(true);
    expect(fm).toEqual({ title: "With BOM", tags: ["a"] });
    expect(body).toBe("body");
  });
  it("folded and literal block-scalar titles resolve to their text, not the indicator", () => {
    expect(parseFrontmatter("---\ntitle: >-\n  A folded\n  title here\ntags: [x]\n---\n").fm).toEqual({ title: "A folded title here", tags: ["x"] });
    expect(parseFrontmatter("---\ntitle: |\n  Literal title\n---\n").fm.title).toBe("Literal title");
    expect(parseFrontmatter("---\ntitle: >\ntags: [x]\n---\n").fm.title).toBeUndefined();
  });
});

describe("huge diffs are capped", () => {
  it("capDiff keeps the head and says what was cut", async () => {
    const { capDiff } = await import("../src/diff.js");
    const d = Array.from({ length: 500 }, (_, i) => `+ l${i}`).join("\n");
    const c = capDiff(d, 200);
    expect(c.split("\n")).toHaveLength(201);
    expect(c).toContain("300 more line(s)");
    expect(capDiff("a\nb", 200)).toBe("a\nb");
  });
});
