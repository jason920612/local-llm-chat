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

  return db;
}

export const db: Database.Database =
  globalForDb.__llmChatDb ?? (globalForDb.__llmChatDb = init());
