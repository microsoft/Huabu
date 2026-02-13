import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

let db: Database.Database | null = null;

function getKnowledgeDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at: apps/server/src/modules/knowledge/*.ts
  // We want: apps/server/data
  const dataDir = path.resolve(here, '../../../data');
  return path.join(dataDir, 'knowledge.sqlite');
}

/**
 * Apply database migrations for knowledge store
 */
function migrate(database: Database.Database): void {
  database.pragma('journal_mode = WAL');

  database.exec(`
    -- Sources table: stores metadata and current content snapshot for all data sources
    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('web', 'pdf', 'note', 'text')),
      title TEXT,
      uri TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      meta_json TEXT
    );

    -- Source revisions table: stores version history for editable sources (note/text)
    CREATE TABLE IF NOT EXISTS source_revisions (
      revision_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      meta_json TEXT,
      FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
    );

    -- Indexes for efficient queries
    CREATE INDEX IF NOT EXISTS idx_sources_workspace_id
      ON sources(workspace_id);

    CREATE INDEX IF NOT EXISTS idx_sources_type
      ON sources(type);

    CREATE INDEX IF NOT EXISTS idx_sources_content_hash
      ON sources(content_hash);

    CREATE INDEX IF NOT EXISTS idx_revisions_source_id
      ON source_revisions(source_id);

    CREATE INDEX IF NOT EXISTS idx_revisions_created_at
      ON source_revisions(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_revisions_workspace_source
      ON source_revisions(workspace_id, source_id);
  `);
}

/**
 * Get or initialize the knowledge database connection
 */
export function getKnowledgeDb(): Database.Database {
  if (db) return db;

  const dbPath = getKnowledgeDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  migrate(db);

  return db;
}

/**
 * Close the knowledge database connection (for cleanup/testing)
 */
export function closeKnowledgeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
