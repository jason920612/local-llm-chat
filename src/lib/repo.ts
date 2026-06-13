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
} from "./types";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  images: string | null;
  videos: string | null;
  files: string | null;
  tool_calls: string | null;
  citations: string | null;
  created_at: number;
  parent_id: string | null;
  active_child_id: string | null;
}

function rowToMessage(row: MessageRow): UIMessage {
  return {
    id: row.id,
    role: row.role as Role,
    content: row.content,
    images: row.images ? (JSON.parse(row.images) as string[]) : undefined,
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

/** Read a conversation's rolling compaction summary + how far it covers. */
export function getCompaction(
  conversationId: string,
): { summary: string | null; summaryThroughId: string | null } {
  const row = db
    .prepare(
      `SELECT summary, summary_through_id AS throughId
       FROM conversations WHERE id = ?`,
    )
    .get(conversationId) as
    | { summary: string | null; throughId: string | null }
    | undefined;
  return {
    summary: row?.summary ?? null,
    summaryThroughId: row?.throughId ?? null,
  };
}

/** Persist a conversation's rolling compaction summary. */
export function setCompaction(
  conversationId: string,
  summary: string,
  summaryThroughId: string,
): void {
  db.prepare(
    `UPDATE conversations SET summary = ?, summary_through_id = ? WHERE id = ?`,
  ).run(summary, summaryThroughId, conversationId);
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
       (id, conversation_id, role, content, images, videos, files, tool_calls, citations, created_at, parent_id, active_child_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    conversationId,
    m.role,
    m.content,
    m.images ? JSON.stringify(m.images) : null,
    m.videos ? JSON.stringify(m.videos) : null,
    m.files ? JSON.stringify(m.files) : null,
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    m.citations ? JSON.stringify(m.citations) : null,
    now,
    parentId,
    activeChild,
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
