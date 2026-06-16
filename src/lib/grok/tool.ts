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
      "Search X and the web via Grok and get a concise, synthesized answer. Use ONLY when the question needs real-time, recent, or external information you do not already know — e.g. current events, news, prices, weather, sports results, or what people are posting on X. Do NOT use it for general knowledge, math, coding, or anything you can answer directly.",
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

/**
 * Image-generation tool. When the model calls it, the pipeline generates an
 * image via Grok Imagine and attaches it to the reply.
 */
export const generateImageTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image from a text description using Grok Imagine. Use when the user asks to create, draw, generate, or imagine a picture/image/logo/art. The image is shown to the user automatically.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "A vivid, detailed English description of the image to generate.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};
