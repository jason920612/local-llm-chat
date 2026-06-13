import OpenAI from "openai";
import { config } from "./config";

/**
 * OpenAI-compatible client pointed at LM Studio / llama.cpp (local).
 * Used for local chat completions (incl. vision) and embeddings.
 */
export const llm = new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
});

/**
 * OpenAI-compatible client pointed at xAI (Grok), for using a cloud frontier
 * model as the chat backend. Embeddings always stay on the local `llm`.
 */
export const grokClient = new OpenAI({
  baseURL: config.grok.baseURL,
  apiKey: config.grok.apiKey || "missing",
});
