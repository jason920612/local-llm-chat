/**
 * Sandbox execution backend abstraction.
 *
 * A `SandboxDriver` owns *where* a conversation's workspace lives (on the Node
 * host's filesystem) and *how* model-written code runs against it. The rest of
 * the app (run_code tool, file explorer routes) talks only to this interface, so
 * we can swap the weak host-process backend (`LocalProcessDriver`) for a true
 * per-conversation microVM (`MicroVMDriver`) without touching callers.
 */

export interface SandboxFile {
  name: string;
  size: number;
  isText: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  files: SandboxFile[];
  error?: string;
  status?: "exited" | "timeout" | "killed" | "error";
}

export interface CloneResult {
  ok: boolean;
  dir: string; // path relative to the workspace (e.g. "repo")
  tree: string; // top-level file/dir listing
  error?: string;
}

export interface ComputerWindow {
  id: string;
  title: string;
  bbox: [number, number, number, number];
}

export interface ComputerElement {
  id: string;
  kind: "text" | "button" | "input" | "image" | "unknown";
  text?: string;
  bbox: [number, number, number, number];
  center: [number, number];
  confidence?: number;
  source: "ocr" | "window" | "accessibility" | "dom" | "vision";
}

/** A numbered Set-of-Mark element overlaid on the screenshot (v3 grounding). */
export interface ComputerMark {
  mark: number;
  center: [number, number];
  bbox: [number, number, number, number];
  text?: string;
  source?: "detector" | "ocr";
  score?: number;
}

export interface ComputerObservation {
  ok: boolean;
  screen?: { width: number; height: number };
  display?: string;
  screenshot?: {
    path: string;
    dataUrl?: string;
  };
  windows: ComputerWindow[];
  elements: ComputerElement[];
  /** Numbered marks (when a marked observe was requested); target via `mark:N`. */
  marks?: ComputerMark[];
  missing?: string[];
  warnings?: string[];
  error?: string;
}

export interface BrowserElement extends ComputerElement {
  tag?: string;
  role?: string;
  href?: string;
  selector?: string;
}

export interface BrowserObservation {
  ok: boolean;
  screen?: { width: number; height: number };
  url?: string;
  title?: string;
  screenshot?: {
    path: string;
    dataUrl?: string;
  } | null;
  windows: ComputerWindow[];
  elements: BrowserElement[];
  warnings?: string[];
  error?: string;
}

export type ComputerAction =
  | {
      action: "move_mouse" | "left_click" | "right_click";
      x: number;
      y: number;
    }
  | { action: "type_text"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; x?: number; y?: number; amount: number }
  | { action: "wait"; ms?: number };

export interface ComputerActionResult {
  ok: boolean;
  action: string;
  durationMs: number;
  error?: string;
}

export type BrowserAction =
  | { action: "click_element"; elementId: string }
  | { action: "type_element"; elementId: string; text: string }
  | { action: "press"; key: string }
  | { action: "scroll"; amount: number }
  | { action: "wait_for_text"; text: string; timeoutMs?: number };

export interface BrowserActionResult {
  ok: boolean;
  action: string;
  durationMs: number;
  url?: string;
  title?: string;
  error?: string;
}

/**
 * A model-authored GUI action program (computer_action / browser_action). One
 * call carries a sequence of steps with targeting, condition gates and recovery
 * branches; the guest executes it in a single VM round-trip. The detailed schema
 * lives in docs/computer-use-action-plan.md and is validated guest-side, so here
 * a step is a loose structured object that the driver forwards verbatim.
 */
export type ActionStep = Record<string, unknown>;
export interface ActionSequence {
  steps: ActionStep[];
  includeScreenshot?: boolean;
}
export interface ActionSequenceResult {
  ok: boolean;
  handled?: boolean;
  stoppedAt?: number | null;
  durationMs?: number;
  steps?: unknown[];
  observation?: unknown;
  error?: string;
}

/**
 * `watch_video`: sample frames + (optionally) the audio track of a video so the
 * model can "watch" it. xAI has no native video input, so the guest extracts
 * frames (scene-change detection + a duration-scaled budget) and the audio
 * track; frames are fed back through the image-vision path and the audio is
 * transcribed host-side via batch STT. See docs/watch-video-plan.md.
 */
export interface WatchVideoOptions {
  /** Sandbox filename/path under the workspace, OR a URL (video file/page). */
  source: string;
  /** Whether to extract the audio track for host-side transcription. */
  audio?: boolean;
  /** Optional cap for first-pass overview frames. */
  frameCeiling?: number;
}
export interface WatchVideoFrame {
  /** Base64 data URL of the (downscaled) JPEG frame. */
  dataUrl: string;
  /** Frame position in the video, seconds. */
  tSec: number;
  /** ffmpeg scene-change score (0-1) when this was a scene cut; absent for fills. */
  score?: number;
  /** Index of the requested moment when this frame came from inspect_video_moments. */
  momentIndex?: number;
  /** Model-supplied reason for inspecting that moment. */
  reason?: string;
}
/** One contiguous slice of the audio track, for chunked STT with coarse timestamps. */
export interface WatchVideoAudioChunk {
  /** Encoded audio bytes (e.g. mp3) ready to POST to STT. */
  bytes: Uint8Array;
  /** Start time of this chunk within the video, seconds. */
  startSec: number;
  filename: string;
}
export interface WatchVideoResult {
  ok: boolean;
  /** Stable id for re-inspecting this already-acquired video without downloading it again. */
  videoId?: string;
  /** How the source was obtained: a local/uploaded file, a yt-dlp download, or browser playback. */
  via?: "file" | "yt-dlp" | "browser";
  title?: string;
  durationSec?: number;
  frames: WatchVideoFrame[];
  /** Whether any frames were truncated by the frame ceiling. */
  frameCeilingHit?: boolean;
  /**
   * Audio split into contiguous chunks (the guest extracts + splits with ffmpeg;
   * the host reads them off the virtiofs share and transcribes each via STT).
   * Empty when audio was off/unavailable.
   */
  audioChunks?: WatchVideoAudioChunk[];
  /** Note about caps hit (e.g. browser capture cap), surfaced to the model. */
  note?: string;
  error?: string;
}

export interface InspectVideoMoment {
  timeSec: number;
  reason?: string;
}

export interface InspectVideoMomentsOptions {
  videoId: string;
  moments: InspectVideoMoment[];
  windowSec?: number;
  framesPerMoment?: number;
}

export interface InspectVideoMomentsResult {
  ok: boolean;
  videoId?: string;
  title?: string;
  durationSec?: number;
  frames: WatchVideoFrame[];
  error?: string;
}

export interface SandboxDriver {
  readonly name: "local" | "microvm";

  /**
   * Host-side (Node-accessible) absolute path to a conversation's workspace dir.
   * For `local` this is under `data/sandboxes/`; for `microvm` it is the WSL2
   * directory exposed to Windows over a UNC path. All file-explorer operations
   * (list/read/write/tar) act on this path directly.
   */
  workspaceHostPath(conversationId: string): string;

  /** Host-side path to the root that holds every conversation's workspace. */
  sandboxRootHostPath(): string;

  /** Ensure the workspace dir exists; return its host path. */
  prepareWorkspace(conversationId: string): string;

  /** Execute model-written code against the conversation's workspace. */
  runCode(
    conversationId: string,
    language: "python" | "bash",
    code: string,
    opts?: { timeoutMs?: number; jobId?: string },
  ): Promise<RunResult>;

  /**
   * Force-stop a run currently executing for a conversation (used to kill a
   * VM-backed background job). Returns true if something was killed. Optional —
   * drivers without a killable handle may omit it.
   */
  killRun?(conversationId: string, jobId?: string): boolean;

  /** Shallow-clone a git repo into the conversation workspace. */
  cloneRepo(conversationId: string, repoUrl: string): Promise<CloneResult>;

  /** Observe the conversation VM's isolated virtual display. */
  computerObserve?(
    conversationId: string,
    opts?: {
      includeScreenshot?: boolean;
      ocr?: boolean;
      /** Overlay numbered Set-of-Mark marks (v3 grounding). */
      mark?: boolean;
      /** Force re-detection even if the frame looks unchanged. */
      remark?: boolean;
    },
  ): Promise<ComputerObservation>;

  /** Run a GUI action program on the conversation VM's isolated virtual display. */
  computerAction?(
    conversationId: string,
    seq: ActionSequence,
  ): Promise<ActionSequenceResult>;

  /** Open or navigate the isolated VM browser. */
  browserOpenUrl?(
    conversationId: string,
    url: string,
  ): Promise<BrowserActionResult>;

  /** Observe DOM/accessibility-like browser elements in the isolated VM browser. */
  browserObserve?(
    conversationId: string,
    opts?: { includeScreenshot?: boolean },
  ): Promise<BrowserObservation>;

  /** Run a GUI action program against the isolated VM browser. */
  browserAction?(
    conversationId: string,
    seq: ActionSequence,
  ): Promise<ActionSequenceResult>;

  /** Sample frames + audio from a video file/URL so the model can watch it. */
  watchVideo?(
    conversationId: string,
    opts: WatchVideoOptions,
  ): Promise<WatchVideoResult>;

  /** Extract frames around model-selected transcript timestamps from a cached video. */
  inspectVideoMoments?(
    conversationId: string,
    opts: InspectVideoMomentsOptions,
  ): Promise<InspectVideoMomentsResult>;

  /** Remove a conversation's workspace (on conversation delete). */
  deleteSandbox(conversationId: string): void;
}

/** Confine a conversation id to a safe directory-name component. */
export function safeConvId(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe || "default";
}

/** Normalize user-supplied repo references into a clonable git URL. */
export function normalizeRepoUrl(input: string): string | null {
  const url = input.trim();
  if (!url) return null;
  // Full URL (https / git / ssh) — accept as-is.
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url)) return url;
  // "owner/repo" shorthand → GitHub https.
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return null;
}

/** Derive a safe destination folder name from a repo URL. */
export function repoDirName(url: string): string {
  return (
    (url.split(/[/]/).pop() || "repo")
      .replace(/\.git$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "_") || "repo"
  );
}
