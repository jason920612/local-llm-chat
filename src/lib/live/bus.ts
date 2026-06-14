import { EventEmitter } from "node:events";
import type { Conversation, UIMessage } from "../types";

/**
 * In-process pub/sub for live multi-device sync. A single EventEmitter (cached
 * across hot reloads) carries two kinds of topics:
 *   - `conv:<id>` — token/message/branch events for one conversation.
 *   - `global`    — conversation list changes + generation activity.
 *
 * SSE routes subscribe; mutation routes + the generation manager publish. This
 * is single-process only (fine for a self-hosted app — every device talks to
 * the same Node server, which is the SQLite source of truth).
 */

const globalForBus = globalThis as unknown as { __llmBus?: EventEmitter };
const bus =
  globalForBus.__llmBus ??
  (globalForBus.__llmBus = (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0); // many devices/tabs may subscribe at once
    return e;
  })());

export type GenStatus = "streaming" | "done" | "error";

/** Events scoped to a single conversation. */
export type ConvEvent =
  | { type: "token"; messageId: string; chunk: string }
  | { type: "message"; message: UIMessage; status?: GenStatus }
  | { type: "status"; messageId: string; status: GenStatus }
  | { type: "branch"; parentId: string | null; childId: string }
  | { type: "truncate"; afterMessageId: string };

/** App-wide events (conversation list + which conversations are generating). */
export type GlobalEvent =
  | { type: "conv-created"; conversation: Conversation }
  | { type: "conv-updated"; conversation: Conversation }
  | { type: "conv-deleted"; id: string }
  | { type: "generating"; conversationId: string; active: boolean };

export function publishConv(conversationId: string, e: ConvEvent): void {
  bus.emit(`conv:${conversationId}`, e);
}

export function subscribeConv(
  conversationId: string,
  fn: (e: ConvEvent) => void,
): () => void {
  const topic = `conv:${conversationId}`;
  bus.on(topic, fn);
  return () => bus.off(topic, fn);
}

export function publishGlobal(e: GlobalEvent): void {
  bus.emit("global", e);
}

export function subscribeGlobal(fn: (e: GlobalEvent) => void): () => void {
  bus.on("global", fn);
  return () => bus.off("global", fn);
}
