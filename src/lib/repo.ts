import { nanoid } from "nanoid";
import { db } from "./db";
import { vectorToBlob, blobToVector } from "./embeddings";
import type {
  Conversation,
  UIMessage,
  Role,
  Citation,
  RagDocument,
} from "./types";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  images: string | null;
  citations: string | null;
  created_at: number;
}

function rowToMessage(row: MessageRow): UIMessage {
  return {
    id: row.id,
    role: row.role as Role,
    content: row.content,
    images: row.images ? (JSON.parse(row.images) as string[]) : undefined,
    citations: row.citations
      ? (JSON.parse(row.citations) as Citation[])
      : undefined,
    createdAt: row.created_at,
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
): { conversation: Conversation; messages: UIMessage[] } | null {
  const conversation = db
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE id = ?`,
    )
    .get(id) as Conversation | undefined;
  if (!conversation) return null;

  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(id) as MessageRow[];

  return { conversation, messages: rows.map(rowToMessage) };
}

export function renameConversation(id: string, title: string): void {
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(
    (title?.trim() || "Untitled").slice(0, 80),
    id,
  );
}

export function deleteConversation(id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function addMessage(conversationId: string, m: UIMessage): void {
  const now = m.createdAt ?? Date.now();
  // OR REPLACE so a finalized assistant message can overwrite a placeholder.
  db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, conversation_id, role, content, images, citations, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    conversationId,
    m.role,
    m.content,
    m.images ? JSON.stringify(m.images) : null,
    m.citations ? JSON.stringify(m.citations) : null,
    now,
  );
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
