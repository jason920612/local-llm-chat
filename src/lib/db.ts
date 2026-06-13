import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

// Cache the connection across hot reloads in dev.
const globalForDb = globalThis as unknown as {
  __llmChatDb?: Database.Database;
};

function init(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      images          TEXT,
      videos          TEXT,
      citations       TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      idx         INTEGER NOT NULL,
      content     TEXT NOT NULL,
      embedding   BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrations: add columns to pre-existing messages tables (no-op if present).
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN videos TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN files TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN tool_calls TEXT`);
  } catch {
    /* column already exists */
  }
  // Message tree (versions/branches): parent_id links a message to the one it
  // follows; active_child_id remembers which child branch is currently selected;
  // conversations.root_child_id remembers the selected first message.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN active_child_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN root_child_id TEXT`);
  } catch {
    /* column already exists */
  }
  // Memory compaction: a rolling summary of older turns + the message id it
  // covers up to (along the active path), so long conversations stay in-context.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN summary TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN summary_through_id TEXT`);
  } catch {
    /* column already exists */
  }

  backfillTree(db);
  return db;
}

/**
 * Link any pre-tree (flat) conversations into a single linear chain so the tree
 * model works on old data. Idempotent: only touches conversations whose
 * root_child_id is still null but which already have messages.
 */
function backfillTree(db: Database.Database): void {
  try {
    const convs = db
      .prepare(`SELECT id FROM conversations WHERE root_child_id IS NULL`)
      .all() as { id: string }[];
    const link = db.prepare(
      `UPDATE messages SET parent_id = ?, active_child_id = ? WHERE id = ?`,
    );
    const setRoot = db.prepare(
      `UPDATE conversations SET root_child_id = ? WHERE id = ?`,
    );
    for (const { id } of convs) {
      const msgs = db
        .prepare(
          `SELECT id FROM messages WHERE conversation_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(id) as { id: string }[];
      if (msgs.length === 0) continue;
      const tx = db.transaction(() => {
        for (let i = 0; i < msgs.length; i++) {
          link.run(
            i > 0 ? msgs[i - 1].id : null,
            i < msgs.length - 1 ? msgs[i + 1].id : null,
            msgs[i].id,
          );
        }
        setRoot.run(msgs[0].id, id);
      });
      tx();
    }
  } catch {
    /* best-effort backfill */
  }
}

export const db: Database.Database =
  globalForDb.__llmChatDb ?? (globalForDb.__llmChatDb = init());
