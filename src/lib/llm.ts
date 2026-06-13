import OpenAI from "openai";
import { config } from "./config";

/**
 * A single OpenAI-compatible client pointed at LM Studio / llama.cpp.
 * Works for chat completions (incl. vision) and embeddings.
 */
export const llm = new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
});
