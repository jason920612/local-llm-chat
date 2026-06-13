import { config } from "./config";
import { getCachedSummary, setCachedSummary } from "./repo";
import { summarizeForCompaction } from "./grok/responses";
import type { UIMessage } from "./types";

/** Rough token estimate (≈ chars / 4) for text content + summary. */
function estTokens(messages: UIMessage[], summary: string): number {
  const chars =
    summary.length + messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}

/**
 * Codex-style auto-compaction with a per-node summary cache.
 *
 * Returns the messages to actually send (older turns dropped) plus a rolling
 * summary representing everything dropped. Summaries are cached keyed by the
 * message id they cover up to; since tree nodes are immutable, switching branches
 * reuses any cached summary whose node is on the new path (no re-summarizing of
 * shared history). New compactions are computed + cached on demand.
 */
export async function compactConversation(
  conversationId: string,
  messages: UIMessage[],
): Promise<{ messages: UIMessage[]; summary: string }> {
  if (!config.compaction.enabled || !conversationId) {
    return { messages, summary: "" };
  }
  const { keepRecent, thresholdTokens } = config.compaction;

  // Find the deepest cached summary whose node lies in the summarizable region
  // (everything before the last keepRecent messages, which we always keep raw).
  let summary = "";
  let throughIdx = -1;
  const limit = Math.max(0, messages.length - keepRecent);
  for (let i = limit - 1; i >= 0; i--) {
    const cached = getCachedSummary(messages[i].id);
    if (cached) {
      summary = cached;
      throughIdx = i;
      break;
    }
  }

  let recent = messages.slice(throughIdx + 1);

  // Compact further while still over budget (usually 0–1 iterations).
  while (
    estTokens(recent, summary) > thresholdTokens &&
    recent.length > keepRecent + 1
  ) {
    const cut = recent.length - keepRecent;
    const toSummarize = recent.slice(0, cut);
    try {
      const next = await summarizeForCompaction(toSummarize, summary || undefined);
      if (!next.trim()) break;
      summary = next;
      setCachedSummary(conversationId, toSummarize[toSummarize.length - 1].id, summary);
      recent = recent.slice(cut);
    } catch {
      break; // summarization failed — send what we have
    }
  }

  return { messages: recent, summary };
}
