// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_VERSION } from './database.js';
import { collisionKeyForTitle } from './identity.js';
import { insertSpaceRow, parseJson } from './rows.js';
import { SqliteStructuredStore } from './structured-store.js';

import type {
  CanvasFile,
  DeltaLogEntry,
} from '../../../canvas/persistence-types.js';

export const SQLITE_TEST_WORLD_ID = 'sqlite-test-world';

export interface SqliteTestFile {
  readonly directory: string;
  readonly filename: string;
  readonly remove: () => void;
}

export interface OpenSqliteTestStore extends SqliteTestFile {
  readonly store: SqliteStructuredStore;
  readonly world: CanvasFile;
  readonly cleanup: () => Promise<void>;
}

export interface EmptySqliteTestStore extends SqliteTestFile {
  readonly store: SqliteStructuredStore;
  readonly cleanup: () => Promise<void>;
}

export function createSqliteTestFile(prefix = 'huabu-sqlite-'): SqliteTestFile {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  const filename = path.join(directory, 'structured.sqlite');
  let removed = false;
  return {
    directory,
    filename,
    remove: () => {
      if (removed) return;
      removed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Run a short test-only query through a connection independent of the store. */
export function withTestDatabase<T>(
  filename: string,
  operation: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(filename);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    return operation(database);
  } finally {
    database.close();
  }
}

/**
 * Seed World without reaching through the adapter under test.
 *
 * The store first creates the production schema. This helper then opens a
 * separate node:sqlite connection and uses the production row encoder, so a
 * contract cannot pass because World creation accidentally shares private
 * adapter state with the operation being exercised.
 */
export function seedSqliteWorld(
  filename: string,
  canvasId = SQLITE_TEST_WORLD_ID,
): CanvasFile {
  const record: CanvasFile = {
    canvasId,
    title: 'World',
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  withTestDatabase(filename, (database) => {
    const version = database.prepare('PRAGMA user_version').get()?.[
      'user_version'
    ];
    if (version !== SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `Expected production SQLite schema v${SQLITE_SCHEMA_VERSION}, got ${String(version)}`,
      );
    }
    insertSpaceRow(
      database,
      record,
      collisionKeyForTitle(record.title, record.canvasId),
      true,
    );
  });
  return record;
}

export async function openSqliteTestStore(
  prefix = 'huabu-sqlite-',
  now?: () => number,
): Promise<OpenSqliteTestStore> {
  const file = createSqliteTestFile(prefix);
  const store = new SqliteStructuredStore(file.filename, now);
  try {
    await store.init();
    const world = seedSqliteWorld(file.filename);
    return {
      ...file,
      store,
      world,
      cleanup: async () => {
        await store.close();
        file.remove();
      },
    };
  } catch (error) {
    await store.close();
    file.remove();
    throw error;
  }
}

export async function openEmptySqliteTestStore(
  prefix = 'huabu-sqlite-empty-',
  now?: () => number,
): Promise<EmptySqliteTestStore> {
  const file = createSqliteTestFile(prefix);
  const store = new SqliteStructuredStore(file.filename, now);
  try {
    await store.init();
    return {
      ...file,
      store,
      cleanup: async () => {
        await store.close();
        file.remove();
      },
    };
  } catch (error) {
    await store.close();
    file.remove();
    throw error;
  }
}

export function readSqliteDeltaLog(
  filename: string,
  canvasId: string,
): DeltaLogEntry[] {
  return withTestDatabase(filename, (database) =>
    database
      .prepare(
        `SELECT entry_json
         FROM delta_log
         WHERE canvas_id = ?
         ORDER BY version`,
      )
      .all(canvasId)
      .map(
        (row, index) =>
          parseJson(
            row['entry_json'],
            `test delta row ${index} for ${canvasId}`,
          ) as DeltaLogEntry,
      ),
  );
}

/** Install a real SQLite failure immediately before a delta row is inserted. */
export function installDeltaAbortTrigger(
  filename: string,
  message: string,
): () => void {
  const quotedMessage = message.split("'").join("''");
  withTestDatabase(filename, (database) => {
    database.exec('DROP TRIGGER IF EXISTS test_abort_delta_insert');
    database.exec(`
      CREATE TRIGGER test_abort_delta_insert
      BEFORE INSERT ON delta_log
      BEGIN
        SELECT RAISE(ABORT, '${quotedMessage}');
      END
    `);
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    withTestDatabase(filename, (database) => {
      database.exec('DROP TRIGGER IF EXISTS test_abort_delta_insert');
    });
  };
}
