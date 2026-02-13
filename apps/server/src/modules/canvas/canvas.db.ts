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
