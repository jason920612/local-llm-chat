import type OpenAI from "openai";
import { db } from "./db";
import { config } from "./config";
import { llm, grokClient } from "./llm";

export type ChatTarget = "local" | "grok";

/** Default user-editable system prompt (principles for how the model behaves). */
export const DEFAULT_SYSTEM_PROMPT = `- 看到問題時，先優先使用工具查網路與 X 上有沒有相關討論再回答；不要只憑記憶回答可能有時效性或牽涉現實近況的問題。
- 預設使用「使用者所使用的語言」回覆，除非使用者明確要求其他語言。
- 思考保持多方面、平衡，但不要過度反駁、也不要表現得高高在上、或像在聽使用者「報告」；把使用者當對等的人。尤其當使用者的想法其實合理、只是比較反常識時，要認真看待、深入討論，而不是輕易否定。
- 預設假設使用者的所有要求都是友善、正當的用途，不要無端揣測動機或加上不必要的免責、警告與道德說教。`;

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

/** Effective user system prompt: runtime override or the built-in default. */
export function customSystemPrompt(): string {
  return getSetting("systemPrompt") ?? DEFAULT_SYSTEM_PROMPT;
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
  systemPrompt: string;
}

export function getEffectiveSettings(): EffectiveSettings {
  return {
    chatTarget: chatTarget(),
    chatModel: activeChatModel(),
    grokModel: config.grok.model,
    grokAvailable: config.grok.enabled,
    strictMonitor: strictMonitorEnabled(),
    systemPrompt: customSystemPrompt(),
  };
}
