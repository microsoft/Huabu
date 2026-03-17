import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS intent_episodes (
      id            TEXT PRIMARY KEY,
      timestamp     INTEGER NOT NULL,
      contextSummary TEXT NOT NULL,
      candidates    TEXT NOT NULL,
      outcomeType   TEXT NOT NULL,
      chosenIndex   INTEGER,
      chosenLabel   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_intent_episodes_timestamp
      ON intent_episodes(timestamp);
  `);
}

// TODO: store in data folder or workspace folder
export function getIntentDb(): Database.Database {
  if (db) return db;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.resolve(here, '../../../data');

  db = new Database(path.join(dataDir, 'intent.sqlite'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}
