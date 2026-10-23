import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "./expect.js";
import { Vault } from "../src/vault.js";
import { tmpVault } from "./helpers.js";

describe("vault jail", () => {
  const root = tmpVault({ "a.md": "# A", "sub/b.md": "# B" });
  const v = new Vault(root);

  it("accepts vault-relative notes", () => {
    expect(v.resolve("sub/b.md").rel).toBe("sub/b.md");
    expect(v.read("a.md")).toBe("# A");
  });

  it.each(["/etc/passwd.md", "C:\\x.md", "~/x.md", "../x.md", "sub/../../x.md", "a\0.md", ".mnemo/index.md", ".MNEMO/x.md", "a.txt", ""])(
    "rejects %j",
    (p) => expect(() => v.resolve(p)).toThrow(),
  );

  it("rejects symlinked files and directories", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md"));
    fs.symlinkSync(outside, path.join(root, "dir"));
    expect(() => v.read("link.md")).toThrow(/Symlink/);
    expect(() => v.read("dir/secret.md")).toThrow(/Symlink/);
    expect(v.listAll()).not.toContain("link.md");
    expect(v.listAll().some((p) => p.startsWith("dir/"))).toBe(false);
  });
});
