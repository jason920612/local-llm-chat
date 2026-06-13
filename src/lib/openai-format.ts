import type OpenAI from "openai";
import type { UIMessage } from "./types";

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Convert UI messages into OpenAI-compatible chat params.
 * Text-only turns use a plain string; turns with images use the multimodal
 * content-parts array (text + image_url data URLs) understood by Gemma 3
 * and other vision models served through LM Studio.
 */
export function toOpenAIMessages(messages: UIMessage[]): ChatParam[] {
  return messages.map((m): ChatParam => {
    if (m.role === "user" && m.images && m.images.length > 0) {
      return {
        role: "user",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.images.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      };
    }
    // assistant / system / text-only user
    return { role: m.role, content: m.content } as ChatParam;
  });
}
