import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Vault, VaultError } from "./vault.js";

/**
 * Named access keys for the hub (mnemo-ctl hub), one per machine or person, issued and revoked by
 * the human with mnemo-ctl. Only a SHA-256 of each key is stored (.mnemo/tokens.json, mode 600),
 * and agents can never read .mnemo/ (vault jail).
 *   agent  - may use the MCP endpoint (/mcp) only: read tools, and propose writes unless read-only.
 *            An agent key can never reach the approval API.
 *   person - may use the Helix API only: view, and approve/reject unless read-only.
 */
export type TokenKind = "agent" | "person";

export interface TokenRecord {
  name: string;
  kind: TokenKind;
  readOnly: boolean;
  hash: string;
  createdAt: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export class TokenStore {
  private file: string;

  constructor(vault: Vault) {
    this.file = path.join(vault.ensureState(), "tokens.json");
  }

  list(): TokenRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as TokenRecord[];
  }

  private save(all: TokenRecord[]) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* not supported on every filesystem */
    }
  }

  /** Create a key. The secret is returned once and never stored. */
  add(name: string, kind: TokenKind, readOnly = false): string {
    if (!NAME.test(name)) throw new VaultError("Key name: lowercase letters, digits, . _ - (up to 40), e.g. office-thinkcentre");
    if (kind !== "agent" && kind !== "person") throw new VaultError("Key kind must be agent or person");
    const all = this.list();
    if (all.some((t) => t.name === name)) throw new VaultError(`A key named ${name} already exists (revoke it first)`);
    const secret = `mn_${kind[0]}_` + crypto.randomBytes(24).toString("base64url");
    all.push({ name, kind, readOnly, hash: sha(secret).toString("hex"), createdAt: new Date().toISOString() });
    this.save(all);
    return secret;
  }

  revoke(name: string): boolean {
    const all = this.list();
    const rest = all.filter((t) => t.name !== name);
    if (rest.length === all.length) return false;
    this.save(rest);
    return true;
  }

  /** The record for a presented secret, compared in constant time; null if unknown. Re-reads the file, so revocation is immediate. */
  verify(secret: string | undefined): TokenRecord | null {
    if (!secret || secret.length > 200) return null;
    const h = sha(secret);
    let found: TokenRecord | null = null;
    for (const t of this.list()) if (crypto.timingSafeEqual(h, Buffer.from(t.hash, "hex"))) found = t;
    return found;
  }
}
