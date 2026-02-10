import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

let db: Database.Database | null = null;

function getCanvasDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at: apps/server/src/modules/canvas/*.ts
  // We want: apps/server/data
  const dataDir = path.resolve(here, '../../../data');
  return path.join(dataDir, 'canvas.sqlite');
}

function migrate(database: Database.Database): void {
  database.pragma('journal_mode = WAL');

  database.exec(`
    CREATE TABLE IF NOT EXISTS canvases (
      canvas_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canvas_nodes (
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      source_id TEXT,
      PRIMARY KEY (canvas_id, node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_canvas_id
      ON canvas_nodes(canvas_id);

    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_source_id
      ON canvas_nodes(source_id);
  `);
}

export function getCanvasDb(): Database.Database {
  if (db) return db;

  const dbPath = getCanvasDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  migrate(db);

  return db;
}
