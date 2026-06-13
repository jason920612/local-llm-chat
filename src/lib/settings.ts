import type OpenAI from "openai";
import { db } from "./db";
import { config } from "./config";
import { llm, grokClient } from "./llm";

export type ChatTarget = "local" | "grok";

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

/** Where chat completions are routed: local LM Studio or xAI Grok (cloud). */
export function chatTarget(): ChatTarget {
  const v = getSetting("chatTarget");
  return v === "grok" && config.grok.enabled ? "grok" : "local";
}

/** The OpenAI-compatible client + model id to use for chat this turn. */
export function chatClient(): { client: OpenAI; model: string } {
  if (chatTarget() === "grok") {
    return { client: grokClient, model: config.grok.model };
  }
  return { client: llm, model: activeChatModel() };
}

export interface EffectiveSettings {
  chatTarget: ChatTarget;
  chatModel: string;
  grokModel: string;
  grokAvailable: boolean;
  strictMonitor: boolean;
}

export function getEffectiveSettings(): EffectiveSettings {
  return {
    chatTarget: chatTarget(),
    chatModel: activeChatModel(),
    grokModel: config.grok.model,
    grokAvailable: config.grok.enabled,
    strictMonitor: strictMonitorEnabled(),
  };
}
