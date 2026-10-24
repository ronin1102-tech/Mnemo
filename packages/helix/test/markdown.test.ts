import { classifyHref, makeResolver, parseBlocks, parseInline, plainText, slug, stripFrontmatter, wordCount } from "../src/markdown";
import { describe, expect, it } from "./expect";

const text = (v: string) => ({ t: "text", v });

describe("reader markdown: blocks", () => {
  it("strips frontmatter only at the very top", () => {
    expect(stripFrontmatter("---\ntags: [a]\n---\n# T\nbody")).toEqual({ body: "# T\nbody", frontmatter: "tags: [a]" });
    expect(stripFrontmatter("# T\n---\nnot frontmatter\n---").frontmatter).toBe(null);
  });
  it("headings, paragraphs with soft breaks, rules, setext", () => {
    expect(parseBlocks("# One\n\nline a\nline b\n\n---\n\nTwo\n===")).toEqual([
      { t: "h", level: 1, c: [text("One")] },
      { t: "p", c: [text("line a"), { t: "br" }, text("line b")] },
      { t: "hr" },
      { t: "h", level: 1, c: [text("Two")] },
    ]);
  });
  it("a #tag at the start of a line is a tag, not a heading", () => {
    expect(parseBlocks("#idea worth keeping")).toEqual([{ t: "p", c: [{ t: "tag", v: "idea" }, text(" worth keeping")] }]);
  });
  it("fenced code is kept verbatim, markup and all", () => {
    expect(parseBlocks("```js\nconst a = **1**;\n<script>x</script>\n```\nafter")).toEqual([
      { t: "code", lang: "js", v: "const a = **1**;\n<script>x</script>" },
      { t: "p", c: [text("after")] },
    ]);
    expect(parseBlocks("~~~\nunclosed")).toEqual([{ t: "code", lang: "", v: "unclosed" }]);
  });
  it("nested lists, ordered start, and tasks", () => {
    const b = parseBlocks("- one\n  - inner\n- [x] done\n- [ ] todo\n\n3. three\n4. four");
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({
      t: "list", ordered: false, start: 1, items: [
        { task: null, c: [{ t: "p", c: [text("one")] }, { t: "list", ordered: false, start: 1, items: [{ task: null, c: [{ t: "p", c: [text("inner")] }] }] }] },
        { task: true, c: [{ t: "p", c: [text("done")] }] },
        { task: false, c: [{ t: "p", c: [text("todo")] }] },
      ],
    });
    expect(b[1]).toMatchObject({ t: "list", ordered: true, start: 3 });
  });
  it("quotes and Obsidian callouts", () => {
    expect(parseBlocks("> said\n> twice")).toEqual([{ t: "quote", c: [{ t: "p", c: [text("said"), { t: "br" }, text("twice")] }] }]);
    expect(parseBlocks("> [!warning] Careful\n> body")).toEqual([{ t: "callout", kind: "warning", title: [text("Careful")], c: [{ t: "p", c: [text("body")] }] }]);
    expect(parseBlocks("> [!tip]")[0]).toMatchObject({ t: "callout", kind: "tip", title: [text("Tip")] });
  });
  it("tables with alignment and escaped pipes", () => {
    expect(parseBlocks("| a | b |\n|:--|--:|\n| 1 | x \\| y |")).toEqual([
      { t: "table", align: ["left", "right"], head: [[text("a")], [text("b")]], rows: [[[text("1")], [text("x | y")]]] },
    ]);
  });
});

describe("reader markdown: inline", () => {
  it("emphasis, nesting, strike, highlight, code", () => {
    expect(parseInline("**b** *i* ~~s~~ ==m== `c`")).toEqual([
      { t: "strong", c: [text("b")] }, text(" "), { t: "em", c: [text("i")] }, text(" "),
      { t: "del", c: [text("s")] }, text(" "), { t: "mark", c: [text("m")] }, text(" "), { t: "code", v: "c" },
    ]);
    expect(parseInline("*a **b** c*")).toEqual([{ t: "em", c: [text("a "), { t: "strong", c: [text("b")] }, text(" c")] }]);
    expect(parseInline("***both***")).toEqual([{ t: "strong", c: [{ t: "em", c: [text("both")] }] }]);
  });
  it("leaves stray delimiters and intraword underscores alone", () => {
    expect(plainText(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
    expect(parseInline("a ** b")).toEqual([text("a ** b")]);
    expect(parseInline("\\*not em\\*")).toEqual([text("*not em*")]);
  });
  it("wikilinks with headings, aliases and embeds", () => {
    expect(parseInline("[[Write gate]]")).toEqual([{ t: "wiki", target: "Write gate", heading: "", label: "Write gate", embed: false }]);
    expect(parseInline("[[notes/Vault jail.md#Symlinks|the jail]]")).toEqual([{ t: "wiki", target: "notes/Vault jail.md", heading: "Symlinks", label: "the jail", embed: false }]);
    expect(parseInline("[[#Top]]")).toEqual([{ t: "wiki", target: "", heading: "Top", label: "Top", embed: false }]);
    expect(parseInline("![[diagram.png]]")[0]).toMatchObject({ t: "wiki", target: "diagram.png", embed: true });
  });
  it("links, autolinks, bare URLs and images", () => {
    expect(parseInline("[the *site*](https://example.com/a_b)")).toEqual([{ t: "link", href: "https://example.com/a_b", c: [text("the "), { t: "em", c: [text("site")] }] }]);
    expect(parseInline("see https://example.com/x.")).toEqual([text("see "), { t: "link", href: "https://example.com/x", c: [text("https://example.com/x")] }, text(".")]);
    expect(parseInline("<mailto:a@b.c>")).toEqual([{ t: "link", href: "mailto:a@b.c", c: [text("a@b.c")] }]);
    expect(parseInline("![alt](pic.png)")).toEqual([{ t: "image", alt: "alt", src: "pic.png" }]);
    expect(parseInline("[w](https://en.wikipedia.org/wiki/Mnemosyne_(goddess)) x")).toEqual([{ t: "link", href: "https://en.wikipedia.org/wiki/Mnemosyne_(goddess)", c: [text("w")] }, text(" x")]);
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([{ t: "link", href: "javascript:alert(1)", c: [text("bad")] }]);
  });
  it("tags need a non-digit and a word boundary", () => {
    expect(parseInline("#project/mnemo and issue #42 and a#b")).toEqual([{ t: "tag", v: "project/mnemo" }, text(" and issue #42 and a#b")]);
  });
  it("HTML in a note is just text", () => {
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([text("<img src=x onerror=alert(1)>")]);
  });
});

describe("reader markdown: links and helpers", () => {
  const resolve = makeResolver(["a.md", "notes/Write gate.md", "deep/notes/b.md", "b.md"]);
  it("resolves wikilink targets like the server does", () => {
    expect(resolve("write gate")).toBe("notes/Write gate.md");
    expect(resolve("b")).toBe("b.md");
    expect(resolve("deep/notes/b.md")).toBe("deep/notes/b.md");
    expect(resolve("missing")).toBe(null);
  });
  it("only http(s) and mailto leave the app; relative .md links open notes", () => {
    expect(classifyHref("https://x.org", "a.md", resolve)).toEqual({ kind: "web", href: "https://x.org" });
    expect(classifyHref("javascript:alert(1)", "a.md", resolve)).toEqual({ kind: "none" });
    expect(classifyHref("JaVaScRiPt:alert(1)", "a.md", resolve)).toEqual({ kind: "none" });
    expect(classifyHref("data:text/html,x", "a.md", resolve)).toEqual({ kind: "none" });
    expect(classifyHref("//evil.example/x", "a.md", resolve)).toEqual({ kind: "none" });
    expect(classifyHref("Write%20gate.md#Top", "notes/x.md", resolve)).toEqual({ kind: "note", path: "notes/Write gate.md", heading: "Top" });
    expect(classifyHref("../a.md", "notes/x.md", resolve)).toEqual({ kind: "note", path: "a.md", heading: "" });
    expect(classifyHref("../../a.md", "notes/x.md", resolve)).toEqual({ kind: "none" });
    expect(classifyHref("#heading", "a.md", resolve)).toEqual({ kind: "none" });
  });
  it("slugs and word counts", () => {
    expect(slug("Hello, World — 2026!")).toBe("hello-world-2026");
    expect(wordCount("# Title\nIt's a **short** note.")).toBe(5);
  });
});
