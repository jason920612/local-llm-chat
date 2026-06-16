import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import type { UIMessage } from "../types";
import {
  insertBackgroundJob,
  updateBackgroundJob,
  getBackgroundJob,
  listBackgroundJobs,
  listBackgroundJobsForDashboard,
  listRunningBackgroundJobs,
  addMessage,
  getConversation,
  historyThrough,
  type BackgroundJob,
  type BgStatus,
} from "../repo";
import { prepareWorkspace, sandboxEnv } from "../sandbox/run";
import { config } from "../config";
import { computePath } from "../tree";
import { publishConv } from "./bus";

/**
 * Agentic background-process manager. The model can launch long-running shell
 * commands (≤ 7 days) in its conversation sandbox, read their logs while they
 * run, list/kill them, and is automatically woken when one finishes so it can
 * react to the exit code + log. Ownership is per-conversation: a conversation's
 * model only sees and controls jobs it started.
 *
 * Real child processes do not survive a server restart; on boot we reconcile
 * any still-"running" rows to "terminated" and wake the model about them.
 */

const MAX_SECONDS = 7 * 24 * 60 * 60; // 7 days
const LOG_CAP = 256 * 1024; // ring-buffer cap per job
const WAKE_RETRY_MS = 1500;
const WAKE_MAX_RETRIES = 600; // ~15 min waiting for the conversation to go idle

interface Live {
  child: ChildProcess;
  job: BackgroundJob;
  log: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const globalForBg = globalThis as unknown as {
  __llmBg?: Map<string, Live>;
  __llmBgBooted?: boolean;
};
const live = globalForBg.__llmBg ?? (globalForBg.__llmBg = new Map<string, Live>());

function countRunning(conversationId: string): number {
  let n = 0;
  for (const l of live.values()) {
    if (l.job.conversationId === conversationId) n++;
  }
  return n;
}

function countRunningGlobal(): number {
  return live.size;
}

export interface StartResult {
  id?: string;
  error?: string;
  timeoutSeconds?: number;
}

/** Launch a background command in the conversation sandbox. */
export function startBackground(
  conversationId: string,
  command: string,
  timeoutSeconds: number,
): StartResult {
  if (!command || !command.trim()) return { error: "command is required" };
  if (config.sandbox.driver === "microvm") {
    // Background jobs still run as host processes; that would bypass the microVM
    // isolation boundary, so they're disabled under the microVM backend until a
    // long-lived per-conversation VM is implemented.
    return {
      error:
        "background jobs are unavailable with the microVM sandbox (run_code only). Use a foreground run_code call instead.",
    };
  }
  const perConversationLimit = config.background.maxConcurrentPerConversation;
  const globalLimit = config.background.maxConcurrentGlobal;
  if (countRunning(conversationId) >= perConversationLimit) {
    return {
      error: `concurrency limit reached (max ${perConversationLimit} per conversation)`,
    };
  }
  if (countRunningGlobal() >= globalLimit) {
    return {
      error: `global background concurrency limit reached (max ${globalLimit})`,
    };
  }
  const secs = Math.max(
    1,
    Math.min(Math.floor(timeoutSeconds) || MAX_SECONDS, MAX_SECONDS),
  );
  const dir = prepareWorkspace(conversationId);
  const id = "bg_" + nanoid(8);
  const now = Date.now();
  const job: BackgroundJob = {
    id,
    conversationId,
    command,
    status: "running",
    exitCode: null,
    log: null,
    startedAt: now,
    timeoutAt: now + secs * 1000,
    endedAt: null,
  };
  insertBackgroundJob(job);

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-c", command], {
      cwd: dir,
      windowsHide: true,
      env: sandboxEnv(),
    });
  } catch (e) {
    updateBackgroundJob(id, {
      status: "exited",
      exitCode: null,
      log: `spawn failed: ${String(e)}`,
      endedAt: Date.now(),
    });
    return { error: "failed to start process (is bash available?)" };
  }

  const l: Live = { child, job, log: "", timer: null };
  const append = (d: Buffer | string) => {
    l.log += d.toString();
    if (l.log.length > LOG_CAP) l.log = l.log.slice(l.log.length - LOG_CAP);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => append(`\n[process error: ${String(err)}]`));

  l.timer = setTimeout(() => {
    if (!live.has(id)) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    finish(id, "timeout", null);
  }, secs * 1000);

  child.on("close", (code) => {
    if (!live.has(id)) return; // already finished via timeout/kill
    finish(id, "exited", code);
  });

  live.set(id, l);
  return { id, timeoutSeconds: secs };
}

/** Read a job's log tail (live buffer while running, else the saved log). */
export function readBackgroundLog(
  conversationId: string,
  id: string,
  tailChars = 4000,
): { status: BgStatus; exitCode: number | null; log: string } | null {
  const l = live.get(id);
  if (l && l.job.conversationId === conversationId) {
    return {
      status: "running",
      exitCode: null,
      log: l.log.slice(-tailChars) || "(no output yet)",
    };
  }
  const job = getBackgroundJob(id);
  if (!job || job.conversationId !== conversationId) return null;
  return {
    status: job.status,
    exitCode: job.exitCode,
    log: (job.log ?? "").slice(-tailChars) || "(no output)",
  };
}

/** Dashboard/admin read: returns a job with live log tail when available. */
export function getBackgroundJobDetail(
  id: string,
  tailChars = 8000,
): (BackgroundJob & { logTail: string }) | null {
  const l = live.get(id);
  if (l) {
    return {
      ...l.job,
      status: "running",
      exitCode: null,
      log: l.log,
      logTail: l.log.slice(-tailChars) || "(no output yet)",
    };
  }
  const job = getBackgroundJob(id);
  if (!job) return null;
  return {
    ...job,
    logTail: (job.log ?? "").slice(-tailChars) || "(no output)",
  };
}

/** Force-kill a running job (only one belonging to this conversation). */
export function killBackground(conversationId: string, id: string): boolean {
  const l = live.get(id);
  if (!l || l.job.conversationId !== conversationId) return false;
  try {
    l.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  finish(id, "killed", null);
  return true;
}

/** Dashboard/admin kill by id. Ownership is resolved from the persisted row. */
export function killBackgroundJob(id: string): boolean {
  const job = getBackgroundJob(id);
  if (!job) return false;
  return killBackground(job.conversationId, id);
}

/** List this conversation's background jobs (newest first). */
export function listBackground(conversationId: string): BackgroundJob[] {
  return listBackgroundJobs(conversationId);
}

export function listBackgroundDashboard(filters: {
  conversationId?: string | null;
  status?: BgStatus | null;
  limit?: number;
} = {}): BackgroundJob[] {
  return listBackgroundJobsForDashboard(filters);
}

function finish(id: string, status: BgStatus, code: number | null): void {
  const l = live.get(id);
  if (!l) return;
  if (l.timer) clearTimeout(l.timer);
  live.delete(id);
  const log = l.log;
  const endedAt = Date.now();
  updateBackgroundJob(id, { status, exitCode: code, log, endedAt });
  void scheduleWake({ ...l.job, status, exitCode: code, log, endedAt });
}

// --- Wake the model on completion ------------------------------------------

function buildEventContent(job: BackgroundJob): string {
  const tail = (job.log ?? "").slice(-3000) || "(no output)";
  const codePart =
    job.exitCode != null ? `（exit code ${job.exitCode}）` : "";
  return [
    "⚙ Background process event (auto-generated)",
    `• id: ${job.id}`,
    `• command: ${job.command}`,
    `• status: ${job.status}${codePart}`,
    "",
    "— log tail —",
    tail,
    "",
    "This background job has finished. Decide and take the next step based on its result.",
  ].join("\n");
}

async function scheduleWake(job: BackgroundJob): Promise<void> {
  // Dynamic import breaks the static cycle (generations → pipeline → responses
  // → background). Resolved at call time, so module init order is unaffected.
  const gens = await import("./generations");
  const tryWake = (tries: number) => {
    if (gens.getActiveForConversation(job.conversationId) && tries < WAKE_MAX_RETRIES) {
      setTimeout(() => tryWake(tries + 1), WAKE_RETRY_MS);
      return;
    }
    wakeNow(job);
  };
  tryWake(0);
}

function wakeNow(job: BackgroundJob): void {
  wakeConversation(job.conversationId, buildEventContent(job));
}

/**
 * Post a system-generated user event into a conversation and kick off a Grok
 * generation so the model reacts to it. Used to wake the model when a background
 * job (or a backgrounded run_code) finishes. No-op if the conversation is gone.
 */
export function wakeConversation(conversationId: string, content: string): void {
  const conv = getConversation(conversationId);
  if (!conv) return; // conversation deleted — nothing to wake

  const path = computePath(conv.messages, conv.rootChildId);
  const parentId = path.length ? path[path.length - 1].id : conv.rootChildId;

  const eventMsg: UIMessage = {
    id: nanoid(),
    role: "user",
    content,
    parentId: parentId ?? null,
    createdAt: Date.now(),
  };
  addMessage(conversationId, eventMsg);
  publishConv(conversationId, { type: "message", message: eventMsg });

  void import("./generations").then(({ startGeneration }) => {
    const history = historyThrough(conversationId, eventMsg.id);
    startGeneration({
      conversationId,
      assistantMessageId: nanoid(),
      parentId: eventMsg.id,
      body: {
        conversationId,
        useGrok: true,
        messages: history.map((m) => ({
          role: m.role,
          content: m.content,
          images: m.images,
        })),
      },
    });
  });
}

// --- Boot reconcile ---------------------------------------------------------

function bootReconcile(): void {
  if (globalForBg.__llmBgBooted) return;
  globalForBg.__llmBgBooted = true;
  let stuck: BackgroundJob[];
  try {
    stuck = listRunningBackgroundJobs();
  } catch {
    return; // DB not ready yet — skip
  }
  for (const job of stuck) {
    const endedAt = Date.now();
    const log = (job.log ?? "") + "\n[server restarted — process terminated]";
    updateBackgroundJob(job.id, { status: "terminated", endedAt, log });
    void scheduleWake({ ...job, status: "terminated", endedAt, log });
  }
}

bootReconcile();
