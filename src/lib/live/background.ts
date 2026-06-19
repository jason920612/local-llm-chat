import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  type BgKind,
  type BgStatus,
} from "../repo";
import {
  prepareWorkspace,
  sandboxEnv,
  runCode,
  killSandboxRun,
  sandboxWorkspacePath,
} from "../sandbox/run";
import type { RunResult } from "../sandbox/driver";
import { config } from "../config";
import { computePath } from "../tree";
import { publishConv } from "./bus";
import { buildTaskLedgerWakeContext, noteTaskProgress } from "../task-ledger";

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

interface WakeQueue {
  contents: string[];
  timer: ReturnType<typeof setTimeout> | null;
  tries: number;
  flushing: boolean;
}

const globalForBg = globalThis as unknown as {
  __llmBg?: Map<string, Live>;
  __llmBgBooted?: boolean;
  __llmVmBg?: Map<string, BackgroundJob>; // jobId -> running VM-backed job
  __llmWakeQueues?: Map<string, WakeQueue>; // conversationId -> pending hidden wakes
};
const live = globalForBg.__llmBg ?? (globalForBg.__llmBg = new Map<string, Live>());
// VM-backed background jobs (microVM driver): the job runs inside the
// conversation's long-lived VM daemon, not as a host child. Many jobs may run
// concurrently inside one conversation VM.
const vmLive =
  globalForBg.__llmVmBg ?? (globalForBg.__llmVmBg = new Map<string, BackgroundJob>());
const wakeQueues =
  globalForBg.__llmWakeQueues ??
  (globalForBg.__llmWakeQueues = new Map<string, WakeQueue>());

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

function shellBasename(value: string): string {
  const unquoted = value.replace(/^["']|["']$/g, "");
  const parts = unquoted.split(/[\\/]/);
  return parts[parts.length - 1] || unquoted;
}

export function normalizeLongRunningCommandClass(command: string): string {
  let s = command.toLowerCase();
  s = s.replace(/\s+/g, " ").trim();
  s = s
    .replace(/-xms\S+/g, "")
    .replace(/-xmx\S+/g, "")
    .replace(/-xx:\S+/g, "")
    .replace(/--enable-native-access=\S+/g, "")
    .replace(
      /(\bjava\b[^;&|\n]*\s-jar\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g,
      (_match, prefix: string, dq?: string, sq?: string, bare?: string) =>
        `${prefix}<jar:${shellBasename(dq ?? sq ?? bare ?? "")}>`,
    )
    .replace(/\s*(?:[12]?>|[12]>>|&>|2>&1)\s*\S+/g, " ")
    .replace(/\s*2>&1\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 240);
}

function normalizeServiceCommand(command: string): string {
  return normalizeLongRunningCommandClass(command);
}

function explicitDaemonWrapper(command: string): boolean {
  return /\b(?:tmux|screen|nohup)\b/i.test(command) || /(?:^|[;&|]\s*)[^&\n]+&\s*$/.test(command);
}

function serviceStartBlocked(conversationId: string, command: string): string | null {
  if (explicitDaemonWrapper(command)) {
    return (
      "service commands must be foreground commands. Do not wrap kind='service' " +
      "commands in tmux, screen, nohup, or '&'; the background manager daemonizes them."
    );
  }
  const sig = normalizeServiceCommand(command);
  const jobs = listBackgroundJobs(conversationId);
  const same = jobs.filter(
    (j) => j.kind === "service" && normalizeServiceCommand(j.command) === sig,
  );
  const running = same.find((j) => j.status === "running");
  if (running) {
    return `service already running for this command class: ${running.id}. Use read_background_log("${running.id}") or kill_background("${running.id}") instead of starting another copy.`;
  }
  const now = Date.now();
  const recent = same.filter((j) => now - j.startedAt < 10 * 60 * 1000);
  const recentFailures = recent.filter((j) =>
    ["exited", "timeout", "terminated", "killed"].includes(j.status),
  );
  if (recentFailures.length >= 2) {
    return `service start blocked after ${recentFailures.length} recent failed/stopped attempts for the same command class. Inspect logs and change strategy before trying again.`;
  }
  const veryRecentStarts = same.filter((j) => now - j.startedAt < 60_000);
  if (veryRecentStarts.length >= 2) {
    return `service start loop blocked: ${veryRecentStarts.length} similar service starts in the last minute. Inspect existing jobs/logs instead of starting another copy.`;
  }
  return null;
}

export interface StartResult {
  id?: string;
  error?: string;
  kind?: BgKind;
  timeoutSeconds?: number;
}

/** Launch a background command in the conversation sandbox. */
export function startBackground(
  conversationId: string,
  command: string,
  timeoutSeconds: number,
  kind: BgKind = "task",
): StartResult {
  if (!command || !command.trim()) return { error: "command is required" };
  const jobKind: BgKind = kind === "service" ? "service" : "task";
  if (jobKind === "service") {
    const blocked = serviceStartBlocked(conversationId, command);
    if (blocked) return { error: blocked, kind: "service" };
  }
  if (config.sandbox.driver === "microvm") {
    // Run the job INSIDE the conversation's microVM (not as a host process), so
    // it stays within the VM isolation boundary.
    return startVmBackground(conversationId, command, timeoutSeconds, jobKind);
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
    kind: jobKind,
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

  if (jobKind !== "service") {
    l.timer = setTimeout(() => {
      if (!live.has(id)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(id, "timeout", null);
    }, secs * 1000);
  }

  child.on("close", (code) => {
    if (!live.has(id)) return; // already finished via timeout/kill
    finish(id, "exited", code);
  });

  live.set(id, l);
  return { id, kind: jobKind, timeoutSeconds: secs };
}

// --- VM-backed background jobs (microVM driver) ----------------------------

/** Combine a finished VM run's streams into one stored log blob. */
function vmRunLog(r: RunResult): string {
  return [
    r.error ? `error: ${r.error}` : "",
    r.stdout ? r.stdout : "",
    r.stderr ? `\n[stderr]\n${r.stderr}` : "",
    r.files.length ? `\n[files] ${r.files.map((f) => f.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("")
    .slice(-LOG_CAP);
}

/** Finalize a VM background job (idempotent): persist result + wake the model. */
function finishVmJob(id: string, conversationId: string, r: RunResult): void {
  const liveJob = vmLive.get(id);
  if (!liveJob) return; // already killed/finalized
  vmLive.delete(id);
  if (
    liveJob.kind === "service" &&
    !r.error &&
    !r.timedOut &&
    r.exitCode === 0
  ) {
    const log = vmRunLog(r);
    updateBackgroundJob(id, {
      status: "running",
      exitCode: null,
      log: log || "service started",
      endedAt: null,
    });
    noteTaskProgress(conversationId, `Background service ${id} started and is marked running.`, {
      backgroundJobs: [`${id} (service running)`],
      evidence: [
        `service ${id} startup probe succeeded`,
        log ? `service ${id} startup log: ${log.slice(-500)}` : "",
      ].filter(Boolean),
      currentPhase: "service running; verify readiness if the task requires it",
      nextAction: `verify ${id} with read_background_log/list_background or user-requested checks before final success`,
    });
    return;
  }
  const status: BgStatus =
    r.status === "killed" ? "killed" : r.timedOut ? "timeout" : "exited";
  const endedAt = Date.now();
  const log = vmRunLog(r);
  updateBackgroundJob(id, { status, exitCode: r.exitCode, log, endedAt });
  noteTaskProgress(conversationId, `Background ${liveJob.kind} ${id} finished with status ${status}.`, {
    backgroundJobs: [`${id} (${liveJob.kind} ${status})`],
    evidence: [
      `background ${id} exit_code=${r.exitCode}${r.timedOut ? " timed_out" : ""}`,
      log ? `background ${id} log tail: ${log.slice(-500)}` : "",
    ].filter(Boolean),
    currentPhase:
      status === "exited" && r.exitCode === 0
        ? "background job completed; reconcile with task goal"
        : "background job failure/stopped; reconcile and continue if actionable",
    nextAction:
      status === "exited" && r.exitCode === 0
        ? "use result as evidence and continue or report verified success"
        : "inspect the failure and choose a different fix if the goal is not satisfied",
  });
  const job = getBackgroundJob(id);
  if (job) void scheduleWake({ ...job, status, exitCode: r.exitCode, log, endedAt });
}

/**
 * Launch a background command inside the conversation's long-lived microVM.
 * The model gets a bg id immediately, can tail the live log while it runs, and
 * is woken on completion. Multiple bg jobs and foreground run_code jobs can
 * coexist in the same conversation VM.
 */
function vmServiceLauncher(id: string, command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return [
    "set -euo pipefail",
    `svc_id=${JSON.stringify(id)}`,
    "svc_dir=\"$PWD/.run/services\"",
    "mkdir -p \"$svc_dir\"",
    "log=\"$svc_dir/$svc_id.log\"",
    "pidfile=\"$svc_dir/$svc_id.pid\"",
    `cmd=$(printf '%s' ${JSON.stringify(encoded)} | base64 -d)`,
    "nohup bash -lc \"$cmd\" >> \"$log\" 2>&1 < /dev/null &",
    "pid=$!",
    "echo \"$pid\" > \"$pidfile\"",
    "sleep 2",
    "if kill -0 \"$pid\" 2>/dev/null; then",
    "  echo \"SERVICE_STARTED id=$svc_id pid=$pid log=$log\"",
    "  exit 0",
    "fi",
    "echo \"SERVICE_FAILED id=$svc_id pid=$pid log=$log\"",
    "tail -120 \"$log\" 2>/dev/null || true",
    "exit 1",
  ].join("\n");
}

function startVmBackground(
  conversationId: string,
  command: string,
  timeoutSeconds: number,
  kind: BgKind,
): StartResult {
  const vmCapSec = Math.floor(config.sandbox.microvm.maxRunMs / 1000);
  const secs = Math.max(
    1,
    Math.min(Math.floor(timeoutSeconds) || MAX_SECONDS, MAX_SECONDS, vmCapSec),
  );
  const id = "bg_" + nanoid(8);
  const now = Date.now();
  const job: BackgroundJob = {
    id,
    conversationId,
    command,
    kind,
    status: "running",
    exitCode: null,
    log: null,
    startedAt: now,
    timeoutAt: now + secs * 1000,
    endedAt: null,
  };
  insertBackgroundJob(job);
  vmLive.set(id, job);

  // Fire the VM daemon job; finalize + wake whenever it resolves (or fails).
  void runCode(conversationId, "bash", kind === "service" ? vmServiceLauncher(id, command) : command, {
    timeoutMs: kind === "service" ? 30_000 : secs * 1000,
    jobId: id,
  }).then(
    (r) => finishVmJob(id, conversationId, r),
    (e) =>
      finishVmJob(id, conversationId, {
        stdout: "",
        stderr: String(e),
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        files: [],
        error: String(e),
      }),
  );
  return { id, kind, timeoutSeconds: secs };
}

function vmServiceLogPath(conversationId: string, id: string): string {
  return path.join(
    sandboxWorkspacePath(conversationId),
    ".run",
    "services",
    `${id}.log`,
  );
}

/** Tail a running VM job's live log (written by the guest over virtio-fs). */
async function readVmLiveLog(
  conversationId: string,
  id: string,
  tailChars: number,
): Promise<string> {
  try {
    const p = path.join(
      sandboxWorkspacePath(conversationId),
      ".run",
      "jobs",
      id,
      "live.log",
    );
    const s = await fs.promises.readFile(p, "utf-8");
    return s.slice(-tailChars) || "(no output yet)";
  } catch {
    return "(no output yet)";
  }
}

async function readVmServiceLog(
  conversationId: string,
  id: string,
  tailChars: number,
): Promise<string> {
  try {
    const s = await fs.promises.readFile(vmServiceLogPath(conversationId, id), "utf-8");
    return s.slice(-tailChars) || "(no output yet)";
  } catch {
    return "(no output yet)";
  }
}

/** Read a job's log tail (live buffer while running, else the saved log). */
export async function readBackgroundLog(
  conversationId: string,
  id: string,
  tailChars = 4000,
): Promise<{ status: BgStatus; exitCode: number | null; log: string } | null> {
  const l = live.get(id);
  if (l && l.job.conversationId === conversationId) {
    return {
      status: "running",
      exitCode: null,
      log: l.log.slice(-tailChars) || "(no output yet)",
    };
  }
  // VM-backed job still running: tail the guest's live.log over virtio-fs.
  const vm = vmLive.get(id);
  if (vm && vm.conversationId === conversationId) {
    return {
      status: "running",
      exitCode: null,
      log: await readVmLiveLog(conversationId, id, tailChars),
    };
  }
  const job = getBackgroundJob(id);
  if (!job || job.conversationId !== conversationId) return null;
  if (job.kind === "service" && job.status === "running") {
    return {
      status: "running",
      exitCode: null,
      log: await readVmServiceLog(conversationId, id, tailChars),
    };
  }
  return {
    status: job.status,
    exitCode: job.exitCode,
    log: (job.log ?? "").slice(-tailChars) || "(no output)",
  };
}

function readVmServiceLogSync(
  conversationId: string,
  id: string,
  tailChars: number,
): string {
  try {
    const s = fs.readFileSync(vmServiceLogPath(conversationId, id), "utf-8");
    return s.slice(-tailChars) || "(no output yet)";
  } catch {
    return "(no output yet)";
  }
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
  const vm = vmLive.get(id);
  if (vm) {
    return {
      ...vm,
      status: "running",
      exitCode: null,
      logTail: readVmLiveLogSync(vm.conversationId, id, tailChars),
    };
  }
  if (job.kind === "service" && job.status === "running") {
    return {
      ...job,
      logTail: readVmServiceLogSync(job.conversationId, id, tailChars),
    };
  }
  return {
    ...job,
    logTail: (job.log ?? "").slice(-tailChars) || "(no output)",
  };
}

function readVmLiveLogSync(
  conversationId: string,
  id: string,
  tailChars: number,
): string {
  try {
    const p = path.join(
      sandboxWorkspacePath(conversationId),
      ".run",
      "jobs",
      id,
      "live.log",
    );
    const s = fs.readFileSync(p, "utf-8");
    return s.slice(-tailChars) || "(no output yet)";
  } catch {
    return "(no output yet)";
  }
}

/** Force-kill a running job (only one belonging to this conversation). */
export function killBackground(conversationId: string, id: string): boolean {
  // VM-backed job: tear down the microVM run.
  const vm = vmLive.get(id);
  if (vm && vm.conversationId === conversationId) {
    killSandboxRun(conversationId, id);
    vmLive.delete(id);
    const endedAt = Date.now();
    const log = readVmLiveLogSync(conversationId, id, LOG_CAP) || "(killed)";
    updateBackgroundJob(id, { status: "killed", exitCode: null, log, endedAt });
    return true;
  }
  const l = live.get(id);
  if (l && l.job.conversationId === conversationId) {
    try {
      l.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    finish(id, "killed", null, false);
    return true;
  }
  const persisted = getBackgroundJob(id);
  if (
    persisted &&
    persisted.conversationId === conversationId &&
    persisted.kind === "service" &&
    persisted.status === "running"
  ) {
    const killScript = [
      "set -e",
      `id=${JSON.stringify(id)}`,
      "pidfile=\"$PWD/.run/services/$id.pid\"",
      "if [ -f \"$pidfile\" ]; then",
      "  pid=$(cat \"$pidfile\" 2>/dev/null || true)",
      "  if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
      "    kill \"$pid\" 2>/dev/null || true",
      "    sleep 1",
      "    kill -9 \"$pid\" 2>/dev/null || true",
      "  fi",
      "fi",
    ].join("\n");
    void runCode(conversationId, "bash", killScript, {
      timeoutMs: 10_000,
      jobId: `${id}_kill`,
    }).catch(() => undefined);
    const endedAt = Date.now();
    const log = readVmServiceLogSync(conversationId, id, LOG_CAP) || "(killed)";
    updateBackgroundJob(id, { status: "killed", exitCode: null, log, endedAt });
    return true;
  }
  return false;
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

function finish(
  id: string,
  status: BgStatus,
  code: number | null,
  wake = true,
): void {
  const l = live.get(id);
  if (!l) return;
  if (l.timer) clearTimeout(l.timer);
  live.delete(id);
  const log = l.log;
  const endedAt = Date.now();
  updateBackgroundJob(id, { status, exitCode: code, log, endedAt });
  noteTaskProgress(l.job.conversationId, `Background ${l.job.kind} ${id} finished with status ${status}.`, {
    backgroundJobs: [`${id} (${l.job.kind} ${status})`],
    evidence: [
      `background ${id} exit_code=${code}`,
      log ? `background ${id} log tail: ${log.slice(-500)}` : "",
    ].filter(Boolean),
    currentPhase:
      status === "exited" && code === 0
        ? "background job completed; reconcile with task goal"
        : "background job failure/stopped; reconcile and continue if actionable",
    nextAction:
      status === "exited" && code === 0
        ? "use result as evidence and continue or report verified success"
        : "inspect the failure and choose a different fix if the goal is not satisfied",
  });
  if (wake) void scheduleWake({ ...l.job, status, exitCode: code, log, endedAt });
}

// --- Wake the model on completion ------------------------------------------

function buildEventContent(job: BackgroundJob): string {
  const tail = (job.log ?? "").slice(-3000) || "(no output)";
  const codePart = job.exitCode != null ? ` (exit code ${job.exitCode})` : "";
  const isService = job.kind === "service";
  return [
    `INTERNAL TOOL RESULT: ${
      isService ? "background_service_stopped" : "background_process_completed"
    }`,
    `WAKE_REASON: background ${job.kind} ${job.id} has finished or changed state.`,
    "This is a server-generated tool result, not a user message.",
    "The previous user request is NOT being asked again.",
    "You are resuming only to handle this completed background result.",
    `id: ${job.id}`,
    `kind: ${job.kind}`,
    `command: ${job.command}`,
    `status: ${job.status}${codePart}`,
    "",
    "log tail:",
    tail,
    "",
    isService
      ? "This long-running service is no longer confirmed running. Check logs/status first; do not restart it with the same command unless you have identified a concrete reason."
      : "This background job has finished. Decide and take the next step based on its result.",
    "",
    "EXPECTED_ASSISTANT_BEHAVIOR:",
    "- Reply to the user with the result of this completed background job.",
    "- Briefly state what finished, whether it succeeded, and the useful output or next action.",
    "- Reconcile this event with CURRENT_BACKGROUND_STATE and the latest assistant reply before drawing a conclusion.",
    "- If a newer job or a later assistant result already satisfied the user's goal, treat this older event as historical context and do not contradict the success.",
    "- If the user's requested goal is still unsatisfied and the failure is actionable, continue with a different fix without asking the user whether to proceed.",
    "- Do not repeat the full answer to the original user request.",
    "- Do not rerun this completed command or start a replacement background job unless the user explicitly asks for another run.",
  ].join("\n");
}

function jobLogTailForWake(job: BackgroundJob): string {
  if (job.kind === "service" && job.status === "running") {
    return readVmServiceLogSync(job.conversationId, job.id, 1200);
  }
  const vm = vmLive.get(job.id);
  if (vm) return readVmLiveLogSync(job.conversationId, job.id, 1200);
  return (job.log ?? "").slice(-1200) || "(no output)";
}

function buildCurrentBackgroundState(conversationId: string): string {
  const jobs = listBackgroundJobs(conversationId).slice(0, 12);
  const lines = [
    "CURRENT_BACKGROUND_STATE (authoritative at wake time; newest first):",
  ];
  if (jobs.length === 0) {
    lines.push("- no tracked background jobs in this conversation");
  } else {
    for (const job of jobs) {
      const exit = job.exitCode != null ? ` exit_code=${job.exitCode}` : "";
      const started = new Date(job.startedAt).toISOString();
      const ended = job.endedAt ? ` ended_at=${new Date(job.endedAt).toISOString()}` : "";
      lines.push(
        `- ${job.id} [${job.kind} ${job.status}${exit}] started_at=${started}${ended}`,
        `  command: ${job.command}`,
      );
      if (job.kind === "service" || job.status !== "running") {
        lines.push("  log_tail:", indentWakeBlock(jobLogTailForWake(job), "    "));
      }
    }
  }
  lines.push(
    "",
    "STATE_RECONCILIATION_RULES:",
    "- This snapshot is newer than the individual completion events above; use it as the source of truth for current background state.",
    "- Older failed jobs can be superseded by newer jobs or by work already completed in the latest assistant response.",
    "- Do not tell the user the goal failed solely because an older event failed if CURRENT_BACKGROUND_STATE or the latest assistant response shows the goal was later satisfied.",
    "- If the user's requested goal remains unsatisfied and the failure is actionable, continue fixing it with a different approach without asking whether to continue.",
    "- If the user's requested goal is already satisfied, give only a concise latest-status update and do not rerun completed work.",
  );
  return lines.join("\n");
}

function indentWakeBlock(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .slice(-40)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function scheduleWake(job: BackgroundJob): Promise<void> {
  wakeConversationWhenIdle(job.conversationId, buildEventContent(job));
}

export function wakeConversationWhenIdle(
  conversationId: string,
  content: string,
): void {
  const q =
    wakeQueues.get(conversationId) ??
    ({ contents: [], timer: null, tries: 0, flushing: false } satisfies WakeQueue);
  q.contents.push(content);
  wakeQueues.set(conversationId, q);
  scheduleWakeDrain(conversationId, 0);
}

function scheduleWakeDrain(conversationId: string, delayMs: number): void {
  const q = wakeQueues.get(conversationId);
  if (!q || q.timer) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    void drainWakeQueue(conversationId);
  }, delayMs);
}

async function drainWakeQueue(conversationId: string): Promise<void> {
  const q = wakeQueues.get(conversationId);
  if (!q || q.flushing || q.contents.length === 0) return;
  q.flushing = true;
  try {
    // Dynamic import breaks the static cycle (generations -> pipeline ->
    // responses -> background). Resolved at call time, so module init order is
    // unaffected.
    const gens = await import("./generations");
    if (gens.getRunningForConversation(conversationId)) {
      q.tries += 1;
      if (q.tries === WAKE_MAX_RETRIES) {
        console.warn(
          `[background-wake-waiting] conv=${conversationId} still has a running generation; queued wakes will stay pending`,
        );
      }
      scheduleWakeDrain(conversationId, WAKE_RETRY_MS);
      return;
    }

    const contents = q.contents.splice(0);
    q.tries = 0;
    if (q.contents.length === 0 && !q.timer) wakeQueues.delete(conversationId);
    const combined =
      contents.length === 1
        ? contents[0]
        : [
            "INTERNAL TOOL RESULT: multiple_background_events",
            "WAKE_REASON: multiple background jobs completed while the assistant was busy or offline.",
            "This is a bundled server-generated tool result, not a user message.",
            "The previous user request is NOT being asked again.",
            "Reconcile these events with CURRENT_BACKGROUND_STATE and the latest assistant reply before drawing conclusions.",
            "If the user's requested goal is still unsatisfied and an event shows an actionable failure, continue fixing it without asking whether to proceed.",
            "If a newer job or later assistant result already satisfied the user's goal, treat older failures as historical and do not contradict the success.",
            "Reply with the latest accurate status; do not repeat the original answer or rerun completed work.",
            ...contents.map((c, i) => [`event ${i + 1}:`, c].join("\n")),
          ].join("\n\n---\n\n");
    const withState = [
      combined,
      buildTaskLedgerWakeContext(conversationId),
      buildCurrentBackgroundState(conversationId),
    ].join("\n\n---\n\n");
    wakeConversation(conversationId, withState);
  } finally {
    const latest = wakeQueues.get(conversationId);
    if (latest) {
      latest.flushing = false;
      if (latest.contents.length > 0) scheduleWakeDrain(conversationId, 0);
    }
  }
}

/**
 * Post a hidden system/tool event into a conversation and kick off a Grok
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
    role: "system",
    content,
    parentId: parentId ?? null,
    createdAt: Date.now(),
  };
  addMessage(conversationId, eventMsg);
  publishConv(conversationId, { type: "message", message: eventMsg });

  void import("./generations").then(({ startGeneration }) => {
    const history = historyThrough(conversationId, eventMsg.id);
    const started = startGeneration({
      conversationId,
      assistantMessageId: nanoid(),
      parentId: eventMsg.id,
      body: {
        conversationId,
        useGrok: true,
        messages: [
          ...history.map((m) => ({
            role: m.role,
            content: m.content,
            images: m.images,
          })),
          {
            role: "system" as const,
            content:
              "BACKGROUND WAKE HANDLING: The latest system message is a completed background/tool result, not a new user request. First reconcile it with CURRENT_BACKGROUND_STATE and the latest assistant reply. If a newer job or later assistant reply already satisfied the user's goal, treat older failures as historical and do not contradict that success. If the requested goal is still unsatisfied and the failure is actionable, continue fixing it with a different approach without asking whether to proceed. Reply with the latest accurate status, do not repeat the original answer, do not restart completed work, and do not treat the original user message as newly asked again.",
          },
        ],
      },
    });
    if (!started) {
      wakeConversationWhenIdle(conversationId, content);
    }
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
    if (job.kind !== "service") {
      void scheduleWake({ ...job, status: "terminated", endedAt, log });
    }
  }
}

bootReconcile();
