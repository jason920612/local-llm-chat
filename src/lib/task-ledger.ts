import { db } from "./db";
import { listBackgroundJobs } from "./repo";

export type TaskLedgerStatus =
  | "idle"
  | "planning"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked";

export interface TaskLedger {
  goal: string;
  status: TaskLedgerStatus;
  acceptanceCriteria: string[];
  currentPhase: string;
  progress: string[];
  evidence: string[];
  backgroundJobs: string[];
  supersededFailures: string[];
  nextAction: string;
  updatedAt: number;
}

export interface TaskLedgerPatch {
  reset?: boolean;
  goal?: string;
  status?: string;
  acceptanceCriteria?: string[];
  currentPhase?: string;
  progressNote?: string;
  evidence?: string[];
  backgroundJobs?: string[];
  supersededFailures?: string[];
  nextAction?: string;
}

const MAX_TEXT = 700;
const MAX_ITEMS = 16;
const STATUSES = new Set<TaskLedgerStatus>([
  "idle",
  "planning",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "blocked",
]);

function cleanText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function cleanList(value: unknown, maxItems = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = cleanText(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function appendUnique(base: string[], extra: string[], maxItems = MAX_ITEMS): string[] {
  const out = [...base];
  for (const item of extra) {
    const s = cleanText(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(-maxItems);
}

function normalizeStatus(value: string | undefined, fallback: TaskLedgerStatus): TaskLedgerStatus {
  return STATUSES.has(value as TaskLedgerStatus)
    ? (value as TaskLedgerStatus)
    : fallback;
}

function emptyLedger(now = Date.now()): TaskLedger {
  return {
    goal: "",
    status: "idle",
    acceptanceCriteria: [],
    currentPhase: "",
    progress: [],
    evidence: [],
    backgroundJobs: [],
    supersededFailures: [],
    nextAction: "",
    updatedAt: now,
  };
}

function parseLedger(raw: string | null): TaskLedger | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<TaskLedger>;
    const now = Date.now();
    return {
      goal: cleanText(data.goal),
      status: normalizeStatus(data.status, "idle"),
      acceptanceCriteria: cleanList(data.acceptanceCriteria),
      currentPhase: cleanText(data.currentPhase),
      progress: cleanList(data.progress),
      evidence: cleanList(data.evidence),
      backgroundJobs: cleanList(data.backgroundJobs),
      supersededFailures: cleanList(data.supersededFailures),
      nextAction: cleanText(data.nextAction),
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : now,
    };
  } catch {
    return null;
  }
}

export function getTaskLedger(conversationId: string): TaskLedger | null {
  if (!conversationId) return null;
  const row = db
    .prepare(`SELECT state FROM task_states WHERE conversation_id = ?`)
    .get(conversationId) as { state: string } | undefined;
  return parseLedger(row?.state ?? null);
}

export function updateTaskLedger(
  conversationId: string,
  patch: TaskLedgerPatch,
): TaskLedger {
  const now = Date.now();
  const cur = patch.reset ? null : getTaskLedger(conversationId);
  const next = cur ?? emptyLedger(now);

  const goal = cleanText(patch.goal);
  if (goal) next.goal = goal;
  next.status = normalizeStatus(patch.status, next.status === "idle" ? "running" : next.status);

  if (Array.isArray(patch.acceptanceCriteria)) {
    next.acceptanceCriteria = cleanList(patch.acceptanceCriteria);
  }

  const phase = cleanText(patch.currentPhase);
  if (phase) next.currentPhase = phase;

  const progressNote = cleanText(patch.progressNote);
  if (progressNote) next.progress = appendUnique(next.progress, [progressNote]);

  next.evidence = appendUnique(next.evidence, cleanList(patch.evidence));
  next.backgroundJobs = appendUnique(
    next.backgroundJobs,
    cleanList(patch.backgroundJobs, 24),
    24,
  );
  next.supersededFailures = appendUnique(
    next.supersededFailures,
    cleanList(patch.supersededFailures),
  );

  const nextAction = cleanText(patch.nextAction);
  if (nextAction) next.nextAction = nextAction;

  next.updatedAt = now;
  db.prepare(
    `INSERT INTO task_states (conversation_id, state, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  ).run(conversationId, JSON.stringify(next), now);
  return next;
}

export function noteTaskProgress(
  conversationId: string,
  progressNote: string,
  patch: Omit<TaskLedgerPatch, "reset" | "progressNote"> = {},
): TaskLedger | null {
  return updateTaskLedger(conversationId, { ...patch, progressNote });
}

function formatList(items: string[], empty = "(none)"): string {
  return items.length ? items.map((x) => `- ${x}`).join("\n") : empty;
}

export function formatTaskLedgerState(state: TaskLedger): string {
  return [
    `goal: ${state.goal || "(not set)"}`,
    `status: ${state.status}`,
    `current_phase: ${state.currentPhase || "(not set)"}`,
    `next_action: ${state.nextAction || "(not set)"}`,
    "",
    "acceptance_criteria:",
    formatList(state.acceptanceCriteria),
    "",
    "progress:",
    formatList(state.progress),
    "",
    "evidence:",
    formatList(state.evidence),
    "",
    "background_jobs:",
    formatList(state.backgroundJobs),
    "",
    "superseded_failures:",
    formatList(state.supersededFailures),
    "",
    `updated_at: ${new Date(state.updatedAt).toISOString()}`,
  ].join("\n");
}

function backgroundSnapshot(conversationId: string): string {
  const jobs = listBackgroundJobs(conversationId).slice(0, 10);
  if (!jobs.length) return "(none)";
  return jobs
    .map((j) => {
      const exit = j.exitCode != null ? ` exit_code=${j.exitCode}` : "";
      const ended = j.endedAt ? ` ended_at=${new Date(j.endedAt).toISOString()}` : "";
      return `- ${j.id} [${j.kind} ${j.status}${exit}] command=${j.command}${ended}`;
    })
    .join("\n");
}

export function buildTaskLedgerPrompt(
  conversationId: string,
  opts: { canUpdate?: boolean } = {},
): string {
  const state = getTaskLedger(conversationId);
  const canUpdate = opts.canUpdate ?? true;
  return [
    "# TASK LEDGER (hidden durable task state)",
    "Use this as your working memory for the user's current task. It is not user-visible and it is not a user request.",
    canUpdate
      ? "For non-trivial user tasks, call update_task_state at the start, after important tool/background milestones, after verification, and before your final answer."
      : "This backend does not expose update_task_state in the current toolset; treat the ledger below as read-only context.",
    "A good ledger has a goal, acceptance criteria, current phase, evidence, background job ids, superseded failures, and the next action.",
    "When a background/tool event arrives, reconcile it against this ledger, the latest assistant reply, and the current background jobs before deciding what to say.",
    "If a failure is actionable and the user's goal is not yet satisfied, continue with a different fix without asking whether to proceed.",
    "If a later job or verified evidence already satisfies the goal, mark old failures as superseded and do not contradict the success.",
    "",
    "current_task_state:",
    state ? formatTaskLedgerState(state) : "(none yet)",
    "",
    "current_background_jobs:",
    backgroundSnapshot(conversationId),
  ].join("\n");
}

export function buildTaskLedgerWakeContext(conversationId: string): string {
  return [
    "TASK_LEDGER_CONTEXT (authoritative durable task state):",
    buildTaskLedgerPrompt(conversationId),
  ].join("\n");
}
