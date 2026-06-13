import { db } from "./db";
import { config } from "./config";

/**
 * Runtime-overridable settings (persisted in SQLite). These override the
 * env-based defaults in `config` without a restart, so the UI can switch the
 * chat model or the strict-monitor mode on the fly.
 */

function getSetting(key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
  ).run(key, value);
}

/** Effective chat model: runtime override or the env default. */
export function activeChatModel(): string {
  return getSetting("chatModel") ?? config.llm.model;
}

/** Effective strict-monitor flag: runtime override or the env default. */
export function strictMonitorEnabled(): boolean {
  const v = getSetting("strictMonitor");
  if (v === null) return config.sop.strictMonitor;
  return v === "true";
}

export interface EffectiveSettings {
  chatModel: string;
  strictMonitor: boolean;
}

export function getEffectiveSettings(): EffectiveSettings {
  return {
    chatModel: activeChatModel(),
    strictMonitor: strictMonitorEnabled(),
  };
}
