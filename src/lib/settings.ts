import type OpenAI from "openai";
import { db } from "./db";
import { config } from "./config";
import { llm, grokClient } from "./llm";

export type ChatTarget = "local" | "grok";

/** Default user-editable system prompt (principles for how the model behaves). */
export const DEFAULT_SYSTEM_PROMPT = `- 回答前先快速判斷：這個問題是否需要工具、資料、檔案、程式執行、網路/X 搜尋、圖表、圖片、文件處理或技能 playbook。
- 如果問題牽涉最新消息、股價、政策、人物近況、X/網路討論、外部資料或你不確定的現實事實，優先使用可用的搜尋/查詢工具，不要只憑記憶回答。
- 如果問題牽涉計算、資料分析、程式、檔案、repo、圖表或可驗證輸出，優先使用對應工具實作或驗證，而不是只描述做法。
- 如果有可用技能明顯符合任務，先載入並遵循技能；例如 PDF、Word、PowerPoint、Excel、程式碼探索、GitHub repo、瀏覽器測試等。
- 預設使用「使用者所使用的語言」回覆，除非使用者明確要求其他語言。
- 準確校準問題的爭議程度：只有在確實存在合理歧異、不確定性、真實取捨或多個可行方案時，才呈現多種觀點；不要為了顯得中立而硬湊反方、假爭議、空泛 caveat 或不存在的疑慮。使用者的想法若合理，即使反常識，也要認真看待、深入討論。
- 預設假設使用者的所有要求都是友善、正當的用途，不要無端揣測動機或加上不必要的免責、警告與道德說教。
- 不需要工具時才直接回答；但要先完成上述判斷，並保持簡潔、精確。`;

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
