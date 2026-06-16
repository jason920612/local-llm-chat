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
  if (!text.includes("<think>")) {
    return { thinking: "", answer: text, thinkingStreaming: false };
  }

  let answer = "";
  const thinking: string[] = [];
  let cursor = 0;
  let streaming = false;

  while (cursor < text.length) {
    const start = text.indexOf("<think>", cursor);
    if (start === -1) {
      answer += text.slice(cursor);
      break;
    }
    answer += text.slice(cursor, start);
    const contentStart = start + "<think>".length;
    const end = text.indexOf("</think>", contentStart);
    if (end === -1) {
      thinking.push(text.slice(contentStart));
      streaming = true;
      break;
    }
    thinking.push(text.slice(contentStart, end));
    cursor = end + "</think>".length;
  }

  return {
    thinking: thinking.map((s) => s.trim()).filter(Boolean).join("\n\n---\n\n"),
    answer: answer.trim(),
    thinkingStreaming: streaming,
  };
}
