import type OpenAI from "openai";

/**
 * Function-tool exposed to the LOCAL model. When the model calls it, the
 * pipeline executes the query against Grok (X + web search) and returns Grok's
 * synthesized answer — keeping raw search results out of the local context.
 */
export const grokSearchTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "grok_search",
    description:
      "Search X (Twitter) and the web via Grok and get a concise, synthesized answer. Use ONLY when the question needs real-time, recent, or external information you do not already know — e.g. current events, news, prices, weather, sports results, or what people are posting on X. Do NOT use it for general knowledge, math, coding, or anything you can answer directly.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A focused, self-contained natural-language search query describing exactly what to find.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};
