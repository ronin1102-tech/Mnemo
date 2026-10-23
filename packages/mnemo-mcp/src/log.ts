import fs from "node:fs";
import path from "node:path";
import type { Vault } from "./vault.js";

/** JSONL log inside .mnemo/logs. Never writes to stdout (that is the MCP channel). */
export function makeLogger(vault: Vault) {
  const file = path.join(vault.ensureState("logs"), "mnemo.log");
  return (event: string, data: Record<string, unknown> = {}) => {
    try {
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n");
    } catch {
      /* logging must never break a tool call */
    }
  };
}
export type Logger = ReturnType<typeof makeLogger>;
