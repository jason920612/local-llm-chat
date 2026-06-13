export interface ParsedThinking {
  /** Chain-of-thought content (inside <think>…</think>), if any. */
  thinking: string;
  /** The user-facing answer with the think block removed. */
  answer: string;
  /** True while a think block is open but not yet closed (still streaming). */
  thinkingStreaming: boolean;
}

/**
 * Split a model message into its reasoning (<think>…</think>) and the answer.
 * Handles the streaming case where </think> hasn't arrived yet.
 */
export function parseThinking(text: string): ParsedThinking {
  const start = text.indexOf("<think>");
  if (start === -1) {
    return { thinking: "", answer: text, thinkingStreaming: false };
  }
  const end = text.indexOf("</think>");
  if (end === -1) {
    return {
      thinking: text.slice(start + 7),
      answer: text.slice(0, start),
      thinkingStreaming: true,
    };
  }
  const thinking = text.slice(start + 7, end).trim();
  const answer = (text.slice(0, start) + text.slice(end + 8)).trim();
  return { thinking, answer, thinkingStreaming: false };
}
