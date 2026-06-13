/**
 * Central runtime configuration, read from environment variables.
 * Defaults target a stock LM Studio install on localhost.
 */
export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? "http://localhost:1234/v1",
    apiKey: process.env.LLM_API_KEY ?? "lm-studio",
    model: process.env.LLM_MODEL ?? "gemma-3-4b-it",
    embeddingModel:
      process.env.EMBEDDING_MODEL ??
      "text-embedding-nomic-embed-text-v1.5",
  },
  rag: {
    chunkSize: 1000, // characters per chunk
    chunkOverlap: 150,
    topK: 4, // chunks retrieved per query
  },
} as const;
