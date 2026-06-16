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
    // Model used for memory-compaction summaries. Defaults to the chat model;
    // override with GROK_SUMMARY_MODEL for a stronger summarizer if needed.
    summaryModel:
      process.env.GROK_SUMMARY_MODEL ??
      process.env.GROK_MODEL ??
      "grok-build-0.1",
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
    // Execution backend:
    //   "local"   — spawn python/bash directly on the host (NOT isolated; default).
    //   "microvm" — per-conversation Cloud Hypervisor microVM with its own kernel,
    //               run inside WSL2 (true isolation). See src/lib/sandbox/microvm.ts.
    driver: (process.env.SANDBOX_DRIVER ?? "local") as "local" | "microvm",
    microvm: {
      // WSL2 distro that hosts the hypervisor + per-conversation workspaces.
      wslDistro: process.env.SANDBOX_WSL_DISTRO ?? "Ubuntu",
      // Root (inside WSL2) holding one persistent dir per conversation.
      wslSandboxRoot: process.env.SANDBOX_WSL_ROOT ?? "/srv/llm-sandboxes",
      // Where the Phase-0 build artifacts (CH binary, kernel, base rootfs) live.
      wslHome: process.env.SANDBOX_WSL_HOME ?? "/home/jason/llm-sandbox",
      vcpus: Number(process.env.SANDBOX_VM_VCPUS ?? 2),
      // RAM ceiling per VM (Cloud Hypervisor faults pages in lazily, so real use
      // ≈ what the guest touches). Generous so the VM effectively runs in memory
      // and tmpfs /tmp has room.
      memMiB: Number(process.env.SANDBOX_VM_MEM_MIB ?? 8192),
      // Cap on microVMs booting concurrently across all conversations.
      maxConcurrent: Number(process.env.SANDBOX_VM_MAX_CONCURRENT ?? 4),
      // run_code runs in the foreground up to this long; if it hasn't finished,
      // the run is auto-migrated to the background and the model is notified +
      // woken on completion.
      foregroundMs: Number(process.env.SANDBOX_VM_FOREGROUND_MS ?? 10000),
      // Hard ceiling for a single run_code VM (foreground or background).
      maxRunMs: Number(process.env.SANDBOX_VM_MAX_RUN_MS ?? 30 * 60 * 1000),
      // Per-conversation writable system disk (overlay upper + /tmp): apparent
      // size in GiB. Thin-provisioned (sparse) — only real usage hits the host
      // disk, and it persists across runs so apt/system installs stick.
      systemDiskGiB: Number(process.env.SANDBOX_VM_SYSDISK_GIB ?? 100),
    },
  },
  /**
   * Host/local background jobs launched by the model through start_background.
   * These limits intentionally do not affect microVM run_code backgrounding.
   */
  background: {
    maxConcurrentGlobal: Number(
      process.env.BACKGROUND_MAX_CONCURRENT_GLOBAL ?? 8,
    ),
    maxConcurrentPerConversation: Number(
      process.env.BACKGROUND_MAX_CONCURRENT_PER_CONVERSATION ?? 5,
    ),
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
    blocking: envBool("SOP_BLOCKING", true),
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
