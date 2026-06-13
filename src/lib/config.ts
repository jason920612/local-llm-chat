function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

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
  /**
   * Grok (xAI) search tool. Lets the local model borrow Grok's server-side
   * X (Twitter) + web search and receive only Grok's synthesized answer.
   */
  grok: {
    baseURL: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY ?? "",
    model: process.env.GROK_MODEL ?? "grok-build-0.1",
    // A stronger model used only for memory compaction — faithful summarization
    // needs more capability than the cheap chat model (grok-build-0.1 hallucinates
    // summaries). Override with GROK_SUMMARY_MODEL.
    summaryModel: process.env.GROK_SUMMARY_MODEL ?? "grok-4.3",
    enabled: Boolean(process.env.XAI_API_KEY),
    maxRounds: 6, // max tool-call rounds per turn
  },
  /**
   * Code execution sandbox. Runs model-written bash/python in a per-conversation
   * working dir, with a timeout, and auto-deletes old workspaces. NOTE: this runs
   * real code on this machine with the server's permissions — it is workspace
   * isolation + TTL, NOT a security boundary. Off by default.
   */
  sandbox: {
    enabled: envBool("SANDBOX_ENABLED", false),
    timeoutMs: 30000,
    ttlMs: 2 * 60 * 60 * 1000, // delete workspaces older than 2 hours
    maxOutputChars: 20000,
  },
  /**
   * SOP control layer. The SOP is enforced in CODE, not by trusting the prompt.
   * These flags toggle the code-controlled gates around every chat turn.
   */
  sop: {
    // Intent gate: structured pre-check that can short-circuit the turn into a
    // forced clarifying question before any answer is generated.
    intentGate: envBool("SOP_INTENT_GATE", true),
    // Verify gate: structured post-check of the draft against the SOP checklist
    // (only runs in blocking mode).
    verifyGate: envBool("SOP_VERIFY_GATE", false),
    // Blocking mode: generate the full answer, run deterministic + verify gates,
    // and enforce/refuse in code BEFORE sending. Trades streaming UX for control.
    blocking: envBool("SOP_BLOCKING", false),
    // Strict monitor: the most aggressive path. Generate -> monitor (deterministic
    // + LLM audit) -> harsh internal scold-correction on failure -> sanitize so
    // the scolding never leaks -> refuse if still non-compliant. Requires concrete
    // citations whenever sources are available. Implies blocking (non-streaming).
    strictMonitor: envBool("SOP_STRICT_MONITOR", true),
    // Max scold-correction rounds before the monitor gives up and refuses.
    maxCorrections: 2,
    // Code-controlled retries for structured calls — we assume the model returns
    // malformed output and retry, then fail (open or closed) deterministically.
    maxStructuredRetries: 2,
  },
  /**
   * Automatic memory compaction (Codex-style). When the conversation history sent
   * to the model exceeds the token threshold, older turns are summarized into a
   * rolling summary and replaced by it, keeping the most recent turns verbatim.
   */
  compaction: {
    enabled: envBool("COMPACTION", true),
    // Estimated-token threshold (chars/4) above which we compact before sending.
    thresholdTokens: Number(process.env.COMPACTION_THRESHOLD ?? 24000),
    // Number of most-recent messages kept verbatim (never summarized).
    keepRecent: Number(process.env.COMPACTION_KEEP_RECENT ?? 6),
  },
} as const;
