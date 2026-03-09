import path from 'node:path';

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

export function getIntentDb(): Database.Database {
  if (db) return db;

  const dataDir = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    '../../../data',
  );

  db = new Database(path.join(dataDir, 'intent.sqlite'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}
