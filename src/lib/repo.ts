import { nanoid } from "nanoid";
import { db } from "./db";
import { vectorToBlob, blobToVector } from "./embeddings";
import { deleteSandbox } from "./sandbox/run";
import { ancestorsOf } from "./tree";
import type {
  Conversation,
  UIMessage,
  Role,
  Citation,
  RagDocument,
  SandboxFileMeta,
  ToolCallTrace,
  ArtifactMeta,
  ImageRef,
} from "./types";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  images: string | null;
  image_refs: string | null;
  videos: string | null;
  files: string | null;
  tool_calls: string | null;
  citations: string | null;
  artifacts: string | null;
  created_at: number;
  parent_id: string | null;
  active_child_id: string | null;
  status: string | null;
}

function rowToMessage(row: MessageRow): UIMessage {
  return {
    id: row.id,
    role: row.role as Role,
    content: row.content,
    status: (row.status as UIMessage["status"]) ?? undefined,
    images: row.images ? (JSON.parse(row.images) as string[]) : undefined,
    imageRefs: row.image_refs
      ? (JSON.parse(row.image_refs) as ImageRef[])
      : undefined,
    videos: row.videos ? (JSON.parse(row.videos) as string[]) : undefined,
    files: row.files
      ? (JSON.parse(row.files) as SandboxFileMeta[])
      : undefined,
    toolCalls: row.tool_calls
      ? (JSON.parse(row.tool_calls) as ToolCallTrace[])
      : undefined,
    citations: row.citations
      ? (JSON.parse(row.citations) as Citation[])
      : undefined,
    artifacts: row.artifacts
      ? (JSON.parse(row.artifacts) as ArtifactMeta[])
      : undefined,
    createdAt: row.created_at,
    parentId: row.parent_id,
    activeChildId: row.active_child_id,
  };
}

export function listConversations(): Conversation[] {
  return db
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM conversations ORDER BY updated_at DESC`,
    )
    .all() as Conversation[];
}

export function createConversation(title: string): Conversation {
  const now = Date.now();
  const id = nanoid();
  const t = (title?.trim() || "New chat").slice(0, 80);
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, t, now, now);
  return { id, title: t, createdAt: now, updatedAt: now };
}

/** Conversation row only (no messages) — for list-sync broadcasts. */
export function getConversationMeta(id: string): Conversation | null {
  const c = db
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE id = ?`,
    )
    .get(id) as Conversation | undefined;
  return c ?? null;
}

export function getConversation(
  id: string,
): {
  conversation: Conversation;
  messages: UIMessage[];
  rootChildId: string | null;
} | null {
  const conversation = db
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE id = ?`,
    )
    .get(id) as Conversation | undefined;
  if (!conversation) return null;

  const rootRow = db
    .prepare(`SELECT root_child_id AS rootChildId FROM conversations WHERE id = ?`)
    .get(id) as { rootChildId: string | null } | undefined;

  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(id) as MessageRow[];

  return {
    conversation,
    messages: rows.map(rowToMessage),
    rootChildId: rootRow?.rootChildId ?? null,
  };
}

/**
 * Point a node (or the conversation root, when parentId is null) at a specific
 * child branch — used when the user switches between message versions.
 */
export function setActiveChild(
  conversationId: string,
  parentId: string | null,
  childId: string,
): void {
  if (parentId) {
    db.prepare(
      `UPDATE messages SET active_child_id = ? WHERE id = ? AND conversation_id = ?`,
    ).run(childId, parentId, conversationId);
  } else {
    db.prepare(`UPDATE conversations SET root_child_id = ? WHERE id = ?`).run(
      childId,
      conversationId,
    );
  }
}

/** Delete all messages after the given message (by insertion order). */
export function truncateMessagesAfter(
  conversationId: string,
  messageId: string,
): void {
  db.prepare(
    `DELETE FROM messages
     WHERE conversation_id = ?
       AND rowid > (SELECT rowid FROM messages WHERE id = ?)`,
  ).run(conversationId, messageId);
}

/**
 * Copy the path leading to `messageId` (its ancestor chain along the tree) into a
 * new conversation as a fresh linear thread, remapping ids and parent links.
 */
export function forkConversation(
  conversationId: string,
  messageId: string,
  title?: string,
): Conversation | null {
  const src = getConversation(conversationId);
  if (!src) return null;
  const target = src.messages.find((m) => m.id === messageId);
  if (!target) return null;

  const chain = ancestorsOf(src.messages, target); // root → target, in order
  const conv = createConversation(title || `${src.conversation.title} (fork)`);
  const base = Date.now();
  let prevNewId: string | null = null;
  chain.forEach((m, i) => {
    const newId = nanoid();
    addMessage(conv.id, {
      ...m,
      id: newId,
      parentId: prevNewId,
      activeChildId: null,
      createdAt: base + i,
    });
    prevNewId = newId;
  });
  return conv;
}

/**
 * Per-node compaction cache: a summary keyed by the message id it covers up to.
 * Because tree nodes are immutable, a summary keyed by a node id is valid for any
 * branch/path that includes that node — so switching branches reuses cached
 * summaries instead of re-summarizing.
 */
export function getCachedSummary(throughId: string): string | null {
  const r = db
    .prepare(`SELECT summary FROM compactions WHERE through_id = ?`)
    .get(throughId) as { summary: string } | undefined;
  return r?.summary ?? null;
}

export function setCachedSummary(
  conversationId: string,
  throughId: string,
  summary: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO compactions (through_id, conversation_id, summary, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(throughId, conversationId, summary, Date.now());
}

export function renameConversation(id: string, title: string): void {
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(
    (title?.trim() || "Untitled").slice(0, 80),
    id,
  );
}

export function deleteConversation(id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  deleteSandbox(id); // remove any code-execution workspace for this conversation
}

export function addMessage(conversationId: string, m: UIMessage): void {
  const now = m.createdAt ?? Date.now();
  const parentId = m.parentId ?? null;
  // Preserve an existing active_child_id on overwrite (placeholder -> final).
  const existing = db
    .prepare(`SELECT active_child_id AS c FROM messages WHERE id = ?`)
    .get(m.id) as { c: string | null } | undefined;
  const activeChild = m.activeChildId ?? existing?.c ?? null;

  // OR REPLACE so a finalized assistant message can overwrite a placeholder.
  db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, conversation_id, role, content, images, image_refs, videos, files, tool_calls, citations, artifacts, created_at, parent_id, active_child_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    conversationId,
    m.role,
    m.content,
    m.images ? JSON.stringify(m.images) : null,
    m.imageRefs ? JSON.stringify(m.imageRefs) : null,
    m.videos ? JSON.stringify(m.videos) : null,
    m.files ? JSON.stringify(m.files) : null,
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    m.citations ? JSON.stringify(m.citations) : null,
    m.artifacts ? JSON.stringify(m.artifacts) : null,
    now,
    parentId,
    activeChild,
    m.status ?? null,
  );

  // Make this message the selected branch under its parent (or the root), so a
  // freshly added/branched message is what the conversation shows.
  if (parentId) {
    db.prepare(
      `UPDATE messages SET active_child_id = ? WHERE id = ? AND conversation_id = ?`,
    ).run(m.id, parentId, conversationId);
  } else {
    db.prepare(`UPDATE conversations SET root_child_id = ? WHERE id = ?`).run(
      m.id,
      conversationId,
    );
  }

  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
    Date.now(),
    conversationId,
  );
}

/** Set just the partial content of a streaming message (no branch/timestamp churn). */
export function updateMessageContent(
  messageId: string,
  content: string,
): void {
  db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(
    content,
    messageId,
  );
}

/** Update a message's generation status. */
export function setMessageStatus(
  messageId: string,
  status: "streaming" | "done" | "error",
): void {
  db.prepare(`UPDATE messages SET status = ? WHERE id = ?`).run(
    status,
    messageId,
  );
}

/** A single message row by id (for status/branch checks). */
export function getMessage(messageId: string): UIMessage | null {
  const row = db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .get(messageId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * Build the linear history (root → the given message, inclusive) along the tree
 * for a conversation — the server-authoritative way to assemble the prompt
 * input from DB instead of trusting the client to send it.
 */
export function historyThrough(
  conversationId: string,
  messageId: string,
): UIMessage[] {
  const src = getConversation(conversationId);
  if (!src) return [];
  const target = src.messages.find((m) => m.id === messageId);
  if (!target) return [];
  return ancestorsOf(src.messages, target);
}

// --- Background jobs (agentic long-running processes) -----------------------

export type BgStatus =
  | "running"
  | "exited"
  | "killed"
  | "timeout"
  | "terminated";

export interface BackgroundJob {
  id: string;
  conversationId: string;
  command: string;
  status: BgStatus;
  exitCode: number | null;
  log: string | null;
  startedAt: number;
  timeoutAt: number;
  endedAt: number | null;
}

export interface SopControlEvent {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  phase:
    | "intent_check"
    | "tool_policy_check"
    | "execution_check"
    | "answer_check"
    | "correction_loop"
    | "emit"
    | "refuse";
  status: "pass" | "fail";
  violations: string[];
  correctionRounds: number;
  action: string;
  createdAt: number;
}

interface BgRow {
  id: string;
  conversation_id: string;
  command: string;
  status: string;
  exit_code: number | null;
  log: string | null;
  started_at: number;
  timeout_at: number;
  ended_at: number | null;
}

function rowToBg(r: BgRow): BackgroundJob {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    command: r.command,
    status: r.status as BgStatus,
    exitCode: r.exit_code,
    log: r.log,
    startedAt: r.started_at,
    timeoutAt: r.timeout_at,
    endedAt: r.ended_at,
  };
}

export function insertBackgroundJob(j: BackgroundJob): void {
  db.prepare(
    `INSERT INTO background_jobs
       (id, conversation_id, command, status, exit_code, log, started_at, timeout_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.id,
    j.conversationId,
    j.command,
    j.status,
    j.exitCode,
    j.log,
    j.startedAt,
    j.timeoutAt,
    j.endedAt,
  );
}

export function updateBackgroundJob(
  id: string,
  patch: { status?: BgStatus; exitCode?: number | null; log?: string; endedAt?: number | null },
): void {
  const cur = db
    .prepare(`SELECT * FROM background_jobs WHERE id = ?`)
    .get(id) as BgRow | undefined;
  if (!cur) return;
  db.prepare(
    `UPDATE background_jobs SET status = ?, exit_code = ?, log = ?, ended_at = ? WHERE id = ?`,
  ).run(
    patch.status ?? cur.status,
    patch.exitCode !== undefined ? patch.exitCode : cur.exit_code,
    patch.log !== undefined ? patch.log : cur.log,
    patch.endedAt !== undefined ? patch.endedAt : cur.ended_at,
    id,
  );
}

export function getBackgroundJob(id: string): BackgroundJob | null {
  const r = db
    .prepare(`SELECT * FROM background_jobs WHERE id = ?`)
    .get(id) as BgRow | undefined;
  return r ? rowToBg(r) : null;
}

export function listBackgroundJobs(conversationId: string): BackgroundJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM background_jobs WHERE conversation_id = ? ORDER BY started_at DESC`,
    )
    .all(conversationId) as BgRow[];
  return rows.map(rowToBg);
}

export function listBackgroundJobsForDashboard(filters: {
  conversationId?: string | null;
  status?: BgStatus | null;
  limit?: number;
} = {}): BackgroundJob[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.conversationId) {
    clauses.push("conversation_id = ?");
    args.push(filters.conversationId);
  }
  if (filters.status) {
    clauses.push("status = ?");
    args.push(filters.status);
  }
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM background_jobs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...args, limit) as BgRow[];
  return rows.map(rowToBg);
}

/** Jobs still flagged running (used on boot to reconcile after a restart). */
export function listRunningBackgroundJobs(): BackgroundJob[] {
  const rows = db
    .prepare(`SELECT * FROM background_jobs WHERE status = 'running'`)
    .all() as BgRow[];
  return rows.map(rowToBg);
}

// --- SOP control events ----------------------------------------------------

interface SopRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  phase: SopControlEvent["phase"];
  status: SopControlEvent["status"];
  violations: string;
  correction_rounds: number;
  action: string;
  created_at: number;
}

function rowToSopEvent(r: SopRow): SopControlEvent {
  let violations: string[] = [];
  try {
    violations = JSON.parse(r.violations) as string[];
  } catch {
    violations = [];
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    phase: r.phase,
    status: r.status,
    violations,
    correctionRounds: r.correction_rounds,
    action: r.action,
    createdAt: r.created_at,
  };
}

export function insertSopControlEvent(
  event: Omit<SopControlEvent, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  },
): SopControlEvent {
  const full: SopControlEvent = {
    id: event.id ?? nanoid(),
    conversationId: event.conversationId ?? null,
    messageId: event.messageId ?? null,
    phase: event.phase,
    status: event.status,
    violations: event.violations,
    correctionRounds: event.correctionRounds,
    action: event.action,
    createdAt: event.createdAt ?? Date.now(),
  };
  db.prepare(
    `INSERT INTO sop_control_events
       (id, conversation_id, message_id, phase, status, violations, correction_rounds, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.conversationId,
    full.messageId,
    full.phase,
    full.status,
    JSON.stringify(full.violations),
    full.correctionRounds,
    full.action,
    full.createdAt,
  );
  return full;
}

export function listSopControlEvents(filters: {
  conversationId?: string | null;
  limit?: number;
} = {}): SopControlEvent[] {
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
  const rows = filters.conversationId
    ? (db
        .prepare(
          `SELECT * FROM sop_control_events
           WHERE conversation_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(filters.conversationId, limit) as SopRow[])
    : (db
        .prepare(
          `SELECT * FROM sop_control_events
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(limit) as SopRow[]);
  return rows.map(rowToSopEvent);
}

// --- RAG documents ---------------------------------------------------------

export function listDocuments(): RagDocument[] {
  return db
    .prepare(
      `SELECT id, name, type, size, chunk_count AS chunkCount,
              created_at AS createdAt
       FROM documents ORDER BY created_at DESC`,
    )
    .all() as RagDocument[];
}

export function deleteDocument(id: string): void {
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
}

/** Insert a document and its embedded chunks atomically. */
export function createDocumentWithChunks(
  meta: { name: string; type: string; size: number },
  chunks: { content: string; embedding: number[] }[],
): RagDocument {
  const id = nanoid();
  const now = Date.now();

  const insertDoc = db.prepare(
    `INSERT INTO documents (id, name, type, size, chunk_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, idx, content, embedding)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    insertDoc.run(id, meta.name, meta.type, meta.size, chunks.length, now);
    chunks.forEach((c, i) => {
      insertChunk.run(nanoid(), id, i, c.content, vectorToBlob(c.embedding));
    });
  });
  tx();

  return {
    id,
    name: meta.name,
    type: meta.type,
    size: meta.size,
    chunkCount: chunks.length,
    createdAt: now,
  };
}

export interface StoredChunk {
  id: string;
  documentId: string;
  documentName: string;
  idx: number;
  content: string;
  embedding: Float32Array;
}

interface ChunkJoinRow {
  id: string;
  document_id: string;
  documentName: string;
  idx: number;
  content: string;
  embedding: Buffer;
}

/** Load every chunk with its parent document name (for in-memory retrieval). */
export function getAllChunks(): StoredChunk[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.document_id, c.idx, c.content, c.embedding,
              d.name AS documentName
       FROM chunks c JOIN documents d ON d.id = c.document_id`,
    )
    .all() as ChunkJoinRow[];

  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentName: r.documentName,
    idx: r.idx,
    content: r.content,
    embedding: blobToVector(r.embedding),
  }));
}
