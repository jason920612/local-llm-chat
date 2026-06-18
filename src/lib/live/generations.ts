import { nanoid } from "nanoid";
import type { ChatRequestBody, UIMessage } from "../types";
import { runControlledChat } from "../sop/pipeline";
import {
  parseStreamingText,
  parseMediaSentinel,
  parseCitationsHeader,
  parseImagesHeader,
  parseVideosHeader,
} from "../api";
import {
  addMessage,
  updateMessageContent,
  setMessageStatus,
  getConversationMeta,
  historyThrough,
} from "../repo";
import { publishConv, publishGlobal, type GenStatus } from "./bus";

/**
 * Server-authoritative generation manager.
 *
 * A turn is generated in the background (decoupled from any HTTP request), so
 * closing a device never interrupts or loses the answer. Tokens are broadcast
 * live over the bus (SSE) and the message is persisted to SQLite as it streams,
 * so any device — including one that reconnects mid-stream — sees the output.
 */

interface ActiveGen {
  conversationId: string;
  messageId: string;
  parentId: string | null;
  raw: string; // accumulated raw stream text (markers included)
  status: GenStatus;
  startedAt: number;
  cancelled: boolean;
  controller: AbortController; // aborts the upstream model request on cancel
  continueDepth: number; // how many auto-continuations precede this turn
}

// Cap on auto-continuations of one task across turns (each ~maxRounds tool
// rounds). Bounds a runaway loop while letting long agentic GUI/browsing tasks
// keep going far past a single turn's step limit.
const MAX_CONTINUATIONS = 8;

const globalForGen = globalThis as unknown as {
  __llmGens?: Map<string, ActiveGen>;
};
// Keyed by assistant messageId. Kept briefly after completion for late joiners.
const active =
  globalForGen.__llmGens ?? (globalForGen.__llmGens = new Map<string, ActiveGen>());

const PERSIST_INTERVAL_MS = 600;
const KEEP_AFTER_DONE_MS = 30_000;

/** The active (or just-finished) generation for a conversation, if any. */
export function getActiveForConversation(
  conversationId: string,
): ActiveGen | undefined {
  for (const g of active.values()) {
    if (g.conversationId === conversationId) return g;
  }
  return undefined;
}

export function getGeneration(messageId: string): ActiveGen | undefined {
  return active.get(messageId);
}

/** Catch-up snapshot for a device that connects mid-stream. */
export function getConversationSnapshot(
  conversationId: string,
): { messageId: string; raw: string; status: GenStatus } | null {
  const g = getActiveForConversation(conversationId);
  return g ? { messageId: g.messageId, raw: g.raw, status: g.status } : null;
}

/** Request cancellation of an in-flight generation (aborts the upstream model call). */
export function cancelGeneration(messageId: string): void {
  const g = active.get(messageId);
  if (g) {
    g.cancelled = true;
    g.controller.abort();
  }
}

export interface StartGenerationArgs {
  conversationId: string;
  assistantMessageId: string;
  parentId: string | null;
  body: ChatRequestBody;
  /** Auto-continuation depth (0 for a user-initiated turn). */
  continueDepth?: number;
}

/**
 * Create the assistant placeholder, broadcast it, and run the pipeline in the
 * background. Returns immediately; progress flows over the bus + DB.
 */
export function startGeneration(args: StartGenerationArgs): void {
  const { conversationId, assistantMessageId, parentId, body } = args;
  const continueDepth = args.continueDepth ?? 0;

  // 1. Persist an empty streaming placeholder and broadcast it so every device
  //    shows the assistant bubble right away.
  const placeholder: UIMessage = {
    id: assistantMessageId,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    parentId,
    status: "streaming",
  };
  addMessage(conversationId, placeholder);

  const gen: ActiveGen = {
    conversationId,
    messageId: assistantMessageId,
    parentId,
    raw: "",
    status: "streaming",
    startedAt: Date.now(),
    cancelled: false,
    controller: new AbortController(),
    continueDepth,
  };
  active.set(assistantMessageId, gen);

  publishConv(conversationId, {
    type: "message",
    message: placeholder,
    status: "streaming",
  });
  publishGlobal({ type: "generating", conversationId, active: true });

  // 2. Drive the pipeline in the background.
  void run(gen, body);
}

async function run(gen: ActiveGen, body: ChatRequestBody): Promise<void> {
  const { conversationId, messageId } = gen;
  let headerCitations: ReturnType<typeof parseCitationsHeader> = [];
  let headerImages: string[] = [];
  let headerVideos: string[] = [];

  try {
    const res = await runControlledChat(
      { ...body, conversationId, messageId },
      gen.controller.signal,
    );
    headerCitations = parseCitationsHeader(res.headers.get("X-Citations"));
    headerImages = parseImagesHeader(res.headers.get("X-Images"));
    headerVideos = parseVideosHeader(res.headers.get("X-Videos"));

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lastPersist = 0;
      while (true) {
        if (gen.cancelled) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        gen.raw += chunk;
        publishConv(conversationId, { type: "token", messageId, chunk });
        const now = Date.now();
        if (now - lastPersist > PERSIST_INTERVAL_MS) {
          lastPersist = now;
          updateMessageContent(messageId, parseStreamingText(gen.raw).text);
        }
      }
    } else {
      const text = await res.text();
      gen.raw += text;
      publishConv(conversationId, { type: "token", messageId, chunk: text });
    }
    finalize(gen, headerCitations, headerImages, headerVideos);
    maybeContinue(gen, body);
  } catch (err) {
    if (gen.cancelled) {
      // User stopped it — keep whatever streamed so far as the final answer.
      finalize(gen, headerCitations, headerImages, headerVideos);
      return;
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    gen.raw += `\n\n[generation error: ${msg}]`;
    publishConv(conversationId, {
      type: "token",
      messageId,
      chunk: `\n\n[generation error: ${msg}]`,
    });
    finalize(gen, headerCitations, headerImages, headerVideos, "error");
  }
}

/**
 * If the just-finished turn hit the per-turn step cap mid-task (continue flag in
 * the media sentinel), automatically start a fresh continuation turn that
 * re-observes and keeps going — bounded by MAX_CONTINUATIONS. This lets long
 * agentic GUI/browsing tasks run far past one turn's step limit while keeping
 * each turn light (history is rebuilt, not chained, so context stays bounded).
 */
function maybeContinue(gen: ActiveGen, body: ChatRequestBody): void {
  if (gen.cancelled || gen.continueDepth >= MAX_CONTINUATIONS) return;
  const media = parseMediaSentinel(gen.raw);
  if (!media.continue) return;
  const nudge = {
    role: "system" as const,
    content:
      "[auto-continue] 你在上一個回合達到單回合步數上限，但任務尚未完成。接續完成原始任務（不要從頭重來）；若不確定當前狀態先 observe 一次確認。全部完成後再給最終回覆。",
    images: undefined,
  };

  let nextBody: ChatRequestBody;
  if (media.responseId) {
    // Hybrid (preferred): chain on the prior xAI response so the continuation
    // keeps the FULL prior reasoning + tool history. messages is just the nudge.
    nextBody = { ...body, messages: [nudge], priorResponseId: media.responseId };
  } else {
    // Fallback: no response id to chain on — rebuild the visible history + nudge
    // (memory limited to persisted content, but the task continues).
    const history = historyThrough(gen.conversationId, gen.messageId);
    if (!history.length) return;
    const messages = history.map((m) => ({
      role: m.role,
      content: m.content,
      images: m.images,
    }));
    messages.push(nudge);
    nextBody = { ...body, messages, priorResponseId: undefined };
  }

  console.log(
    `[auto-continue] conv=${gen.conversationId} depth=${gen.continueDepth + 1} mode=${
      media.responseId ? `chain(${media.responseId.slice(0, 12)}…)` : "rebuild"
    }`,
  );
  startGeneration({
    conversationId: gen.conversationId,
    assistantMessageId: nanoid(),
    parentId: gen.messageId,
    body: nextBody,
    continueDepth: gen.continueDepth + 1,
  });
}

function finalize(
  gen: ActiveGen,
  headerCitations: ReturnType<typeof parseCitationsHeader>,
  headerImages: string[],
  headerVideos: string[],
  status: GenStatus = "done",
): void {
  const { conversationId, messageId } = gen;
  const media = parseMediaSentinel(gen.raw);
  const parsed = parseStreamingText(gen.raw);

  const citations = [...headerCitations, ...media.citations];
  const images = [...headerImages, ...media.images];
  const imageRefs = media.imageRefs;
  const videos = [...headerVideos, ...media.videos];
  const toolCalls = [...parsed.toolCalls];
  if (media.xai.costInUsdTicks > 0) {
    toolCalls.push({
      tool: "xai_cost",
      args: { cost_in_usd_ticks: media.xai.costInUsdTicks },
    });
  }

  const final: UIMessage = {
    id: messageId,
    role: "assistant",
    content: parsed.text,
    parentId: gen.parentId,
    createdAt: gen.startedAt,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    citations: citations.length ? citations : undefined,
    images: images.length ? images : undefined,
    imageRefs: imageRefs.length ? imageRefs : undefined,
    videos: videos.length ? videos : undefined,
    files: media.files.length ? media.files : undefined,
    artifacts: media.artifacts.length ? media.artifacts : undefined,
    status,
  };
  addMessage(conversationId, final);
  setMessageStatus(messageId, status);

  gen.status = status;
  publishConv(conversationId, { type: "message", message: final, status });
  publishConv(conversationId, { type: "status", messageId, status });
  publishGlobal({ type: "generating", conversationId, active: false });
  const meta = getConversationMeta(conversationId);
  if (meta) publishGlobal({ type: "conv-updated", conversation: meta });

  // Keep the finished buffer around briefly so a device that connects right at
  // completion can still catch up, then drop it.
  setTimeout(() => {
    if (active.get(messageId) === gen) active.delete(messageId);
  }, KEEP_AFTER_DONE_MS);
}
