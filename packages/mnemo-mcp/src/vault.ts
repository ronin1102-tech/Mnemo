import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export const RESERVED_DIR = ".mnemo";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * The vault jail. Every path an agent supplies goes through `resolve`, which
 * accepts only vault-relative `.md` paths and rejects absolute paths, `..`
 * traversal, the reserved `.mnemo/` root, and any symlink on the way down.
 */
export class Vault {
  readonly root: string;
  readonly stateDir: string;

  constructor(root: string) {
    if (!fs.existsSync(root)) throw new VaultError(`Vault directory does not exist: ${root}`);
    this.root = fs.realpathSync(root);
    this.stateDir = path.join(this.root, RESERVED_DIR);
  }

  ensureState(...sub: string[]): string {
    const dir = path.join(this.stateDir, ...sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Normalise an agent-supplied path to a clean vault-relative POSIX path, or throw. */
  normalize(input: string): string {
    if (typeof input !== "string" || input.length === 0) throw new VaultError("Path is required");
    if (input.includes("\0")) throw new VaultError("Invalid path");
    const posix = input.replace(/\\/g, "/");
    if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix) || posix.startsWith("~")) {
      throw new VaultError("Absolute paths are not allowed; use a vault-relative path");
    }
    const parts: string[] = [];
    for (const seg of posix.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") throw new VaultError("Path escapes the vault");
      parts.push(seg);
    }
    if (parts.length === 0) throw new VaultError("Path is required");
    if (parts[0].toLowerCase() === RESERVED_DIR) throw new VaultError(`${RESERVED_DIR}/ is reserved`);
    if (!parts[parts.length - 1].toLowerCase().endsWith(".md")) throw new VaultError("Only .md notes are allowed");
    return parts.join("/");
  }

  /**
   * Resolve to an absolute path inside the vault. No component of the path may
   * be a symlink (checked with lstat), so a link planted in the vault cannot
   * lead outside it.
   */
  resolve(input: string): { rel: string; abs: string } {
    const rel = this.normalize(input);
    let cur = this.root;
    for (const seg of rel.split("/")) {
      cur = path.join(cur, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // does not exist yet; remaining segments are plain names
      }
      if (st.isSymbolicLink()) throw new VaultError("Symlinks are not allowed in the vault");
    }
    const abs = path.join(this.root, ...rel.split("/"));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new VaultError("Path escapes the vault");
    return { rel, abs };
  }

  exists(rel: string): boolean {
    const { abs } = this.resolve(rel);
    return fs.existsSync(abs);
  }

  read(rel: string): string {
    const { abs, rel: r } = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new VaultError(`Note not found: ${r}`);
    if (!fs.statSync(abs).isFile()) throw new VaultError(`Not a note: ${r}`);
    return fs.readFileSync(abs, "utf8");
  }

  /** Walk the vault for notes. Skips `.mnemo/`, dot-directories and symlinks. */
  listAll(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(rel);
      }
    };
    walk(this.root, "");
    return out.sort();
  }

  /**
   * Crash-safe write: temp file in the same directory -> fsync -> rename over the
   * target -> fsync the directory. Readers see the old note or the new one, never half.
   */
  atomicWrite(rel: string, content: string): void {
    const { abs } = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.resolve(rel); // re-check the jail now that parents exist
    const tmp = `${abs}.mnemo-tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, abs);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    try {
      const dfd = fs.openSync(path.dirname(abs), "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {
      /* directory fsync is unsupported on some platforms (Windows) */
    }
  }
}
