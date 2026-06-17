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
