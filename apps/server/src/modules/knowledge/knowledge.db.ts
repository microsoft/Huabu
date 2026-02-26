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
      sourceId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('web', 'pdf', 'note', 'text')),
      title TEXT,
      src TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      content TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      metaJson TEXT
    );

    -- Source revisions table: stores version history for editable sources (note/text)
    CREATE TABLE IF NOT EXISTS source_revisions (
      revisionId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      content TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      metaJson TEXT,
      FOREIGN KEY (sourceId) REFERENCES sources(sourceId) ON DELETE CASCADE
    );

    -- Indexes for efficient queries
    CREATE INDEX IF NOT EXISTS idx_sources_workspaceId
      ON sources(workspaceId);

    CREATE INDEX IF NOT EXISTS idx_sources_type
      ON sources(type);

    CREATE INDEX IF NOT EXISTS idx_sources_contentHash
      ON sources(contentHash);

    CREATE INDEX IF NOT EXISTS idx_revisions_sourceId
      ON source_revisions(sourceId);

    CREATE INDEX IF NOT EXISTS idx_revisions_createdAt
      ON source_revisions(createdAt DESC);

    CREATE INDEX IF NOT EXISTS idx_revisions_workspace_source
      ON source_revisions(workspaceId, sourceId);
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
