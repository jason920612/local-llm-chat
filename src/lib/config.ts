function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function envTier(name: string): "default" | "priority" | undefined {
  const v = process.env[name]?.toLowerCase();
  if (v === "priority") return "priority";
  if (v === "default") return "default";
  return undefined;
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
    embeddingProvider: (
      process.env.EMBEDDING_PROVIDER ?? "local"
    ).toLowerCase() as "local" | "lmstudio" | "auto",
    embeddingModel:
      process.env.EMBEDDING_MODEL ??
      "text-embedding-nomic-embed-text-v1.5",
    localEmbeddingModel:
      process.env.LOCAL_EMBEDDING_MODEL ??
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    localEmbeddingCacheDir:
      process.env.LOCAL_EMBEDDING_CACHE_DIR ?? ".cache/transformers",
  },
  rag: {
    chunkSize: 1000, // characters per chunk
    chunkOverlap: 150,
    topK: 4, // chunks retrieved per query
  },
  /**
   * Grok (xAI) search tool. Lets the local model borrow Grok's server-side
   * X + web search and receive only Grok's synthesized answer.
   */
  grok: {
    baseURL: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    apiKey: process.env.XAI_API_KEY ?? "",
    model: process.env.GROK_MODEL ?? "grok-build-0.1",
    imageModel: process.env.XAI_IMAGE_MODEL ?? "grok-imagine-image-quality",
    videoModel: process.env.XAI_VIDEO_MODEL ?? "grok-imagine-video-1.5",
    // Model used for memory-compaction summaries. Defaults to the chat model;
    // override with GROK_SUMMARY_MODEL for a stronger summarizer if needed.
    summaryModel:
      process.env.GROK_SUMMARY_MODEL ??
      process.env.GROK_MODEL ??
      "grok-build-0.1",
    enabled: Boolean(process.env.XAI_API_KEY),
    // Max tool-call rounds per turn. Higher = the model can run longer
    // observe→act loops (multi-step GUI / browsing tasks) before the turn is
    // forced to finish. Override with GROK_MAX_ROUNDS.
    maxRounds: Number(process.env.GROK_MAX_ROUNDS ?? 48),
    serviceTier: envTier("XAI_SERVICE_TIER"),
    webSearch: {
      enableImageSearch: envBool("XAI_WEB_SEARCH_IMAGE_SEARCH", true),
      enableImageUnderstanding: envBool(
        "XAI_WEB_SEARCH_IMAGE_UNDERSTANDING",
        true,
      ),
    },
    stt: {
      streaming: envBool("XAI_STT_STREAMING", true),
      maxConcurrent: Number(process.env.XAI_STT_MAX_CONCURRENT ?? 4),
      smartTurn: Number(process.env.XAI_STT_SMART_TURN ?? 0.7),
      smartTurnTimeoutMs: Number(
        process.env.XAI_STT_SMART_TURN_TIMEOUT_MS ?? 3000,
      ),
    },
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
      // Long-lived per-conversation VM session ceiling and idle shutdown.
      sessionMaxMs: Number(
        process.env.SANDBOX_VM_SESSION_MAX_MS ?? 6 * 60 * 60 * 1000,
      ),
      idleMs: Number(process.env.SANDBOX_VM_IDLE_MS ?? 30 * 60 * 1000),
      // Per-conversation writable system disk (overlay upper + /tmp): apparent
      // size in GiB. Thin-provisioned (sparse) — only real usage hits the host
      // disk, and it persists across runs so apt/system installs stick.
      systemDiskGiB: Number(process.env.SANDBOX_VM_SYSDISK_GIB ?? 100),
      computer: {
        enabled: envBool("SANDBOX_VM_COMPUTER_USE", true),
        width: Number(process.env.SANDBOX_VM_SCREEN_WIDTH ?? 1280),
        height: Number(process.env.SANDBOX_VM_SCREEN_HEIGHT ?? 720),
        autoInstall: envBool("SANDBOX_VM_COMPUTER_AUTOINSTALL", true),
        ocr: envBool("SANDBOX_VM_COMPUTER_OCR", true),
        // v3 Set-of-Mark grounding: overlay numbered marks on observed screens
        // so the model can point precisely (mark: N) — including text-less icons.
        marking: envBool("SANDBOX_VM_MARKING", true),
        // Re-run detection when the frame changes beyond this fraction (0-1) or a
        // new window appears; otherwise reuse cached marks (bounds GPU cost).
        markDiffThreshold: Number(process.env.SANDBOX_VM_MARK_DIFF ?? 0.06),
        // Human-like real cursor: move the X pointer along an eased, jittered
        // path before a real click (vs teleport). Steps scale with distance.
        humanMouse: envBool("SANDBOX_VM_HUMAN_MOUSE", true),
        humanMouseMaxSteps: Number(process.env.SANDBOX_VM_HUMAN_MOUSE_STEPS ?? 40),
        humanMouseJitter: Number(process.env.SANDBOX_VM_HUMAN_MOUSE_JITTER ?? 2),
      },
      /**
       * Host-side GPU UI-detector service (WSL2). The microVM has no GPU, so the
       * OmniParser YOLO + Florence-2-large models run in a persistent WSL2 CUDA
       * process that serves all VMs over the shared workspace. Launched on demand
       * and idle-exits. See docs/computer-use-v3-grounding-plan.md.
       */
      detector: {
        enabled: envBool("SANDBOX_VM_DETECTOR", true),
        // Caption each detected element with Florence-2 (off = boxes only).
        caption: envBool("SANDBOX_VM_DETECTOR_CAPTION", true),
        // Service idle seconds before it exits and frees VRAM.
        idleSec: Number(process.env.SANDBOX_VM_DETECTOR_IDLE_SEC ?? 600),
        // YOLO confidence threshold and max boxes per frame.
        conf: Number(process.env.SANDBOX_VM_DETECTOR_CONF ?? 0.05),
        maxBoxes: Number(process.env.SANDBOX_VM_DETECTOR_MAX_BOXES ?? 120),
      },
      /**
       * `watch_video`: sample frames (scene-change detection + duration-scaled
       * budget) and transcribe audio so the model can "watch" a video file or a
       * web video. See docs/watch-video-plan.md. xAI has no native video input,
       * so frames go through the image-vision path and audio through batch STT.
       */
      video: {
        enabled: envBool("SANDBOX_VM_WATCH_VIDEO", true),
        // Frame budget = clamp(ceil(minutes * framesPerMin), frameFloor, frameCeiling).
        framesPerMin: Number(process.env.SANDBOX_VM_VIDEO_FRAMES_PER_MIN ?? 6),
        frameFloor: Number(process.env.SANDBOX_VM_VIDEO_FRAME_FLOOR ?? 8),
        frameCeiling: Number(process.env.SANDBOX_VM_VIDEO_FRAME_CEILING ?? 120),
        // ffmpeg scene score (0-1) above which a frame is treated as a change.
        sceneThreshold: Number(
          process.env.SANDBOX_VM_VIDEO_SCENE_THRESHOLD ?? 0.3,
        ),
        // Downscale frames to this long edge before sending (well under 20MiB).
        frameLongEdge: Number(process.env.SANDBOX_VM_VIDEO_FRAME_EDGE ?? 768),
        // Transcribe the audio track by default.
        audio: envBool("SANDBOX_VM_VIDEO_AUDIO", true),
        // yt-dlp max download height (px) for web videos.
        maxQualityHeight: Number(
          process.env.SANDBOX_VM_VIDEO_MAX_QUALITY ?? 720,
        ),
        // Browser-playback fallback: playback rate and capture cap (seconds).
        browserPlaybackRate: Number(
          process.env.SANDBOX_VM_VIDEO_PLAYBACK_RATE ?? 2,
        ),
        browserCaptureCapSec: Number(
          process.env.SANDBOX_VM_VIDEO_CAPTURE_CAP_SEC ?? 15 * 60,
        ),
        // Audio split size (seconds) per STT chunk, for coarse timestamps.
        sttChunkSec: Number(process.env.SANDBOX_VM_VIDEO_STT_CHUNK_SEC ?? 60),
        // Hard ceiling for one watch_video VM job.
        maxJobMs: Number(
          process.env.SANDBOX_VM_VIDEO_MAX_JOB_MS ?? 30 * 60 * 1000,
        ),
      },
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
    // Stance gate: triggered LLM-as-judge check that blocks artificial balance,
    // false equivalence, vague caveats, and unsupported uncertainty.
    stanceGate: envBool("SOP_STANCE_GATE", true),
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
