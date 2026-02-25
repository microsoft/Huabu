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
      canvasId TEXT PRIMARY KEY,
      workspaceId TEXT,
      title TEXT,
      version INTEGER NOT NULL,
      stateJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

const DEFAULT_CANVAS_ID = 'default-canvas';

/**
 * Ensure the default canvas row exists so the client can always load it.
 * Creates an empty canvas with version 0 if it does not exist yet.
 */
function ensureDefaultCanvas(database: Database.Database): void {
  const row = database
    .prepare('SELECT canvasId FROM canvases WHERE canvasId = ?')
    .get(DEFAULT_CANVAS_ID);

  if (!row) {
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO canvases (
          canvasId, workspaceId, title, version, stateJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        DEFAULT_CANVAS_ID,
        'default',
        null,
        0,
        JSON.stringify({ nodes: [], edges: [] }),
        now,
        now,
      );
  }
}

export function getCanvasDb(): Database.Database {
  if (db) return db;

  const dbPath = getCanvasDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  migrate(db);
  ensureDefaultCanvas(db);

  return db;
}
