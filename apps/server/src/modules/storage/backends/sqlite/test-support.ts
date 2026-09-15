// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteStoreContext, SQLITE_SCHEMA_VERSION } from './database.js';
import { collisionKeyForTitle } from './identity.js';
import { insertSpaceRow, parseJson } from './rows.js';
import { SqliteStructuredStore } from './structured-store.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

import type {
  CanvasFile,
  DeltaLogEntry,
} from '../../../canvas/persistence-types.js';

export const SQLITE_TEST_WORLD_ID = 'sqlite-test-world';
export const SQLITE_TEST_WORKSPACE_NAME = 'Test Workspace';

export interface SqliteTestFile {
  readonly directory: string;
  readonly filename: string;
  readonly remove: () => void;
}

export interface EmptySqliteTestStore extends SqliteTestFile {
  readonly store: SqliteStructuredStore;
  readonly context: SqliteStoreContext;
  readonly workspaceId: string;
  /** Drop the connection but keep the file, so a test can reopen it. */
  readonly closeConnection: () => void;
  readonly cleanup: () => Promise<void>;
}

export interface OpenSqliteTestStore extends EmptySqliteTestStore {
  readonly world: CanvasFile;
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
  workspaceId: string,
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
      workspaceId,
      record,
      collisionKeyForTitle(record.title, record.canvasId),
      true,
    );
  });
  return record;
}

/**
 * Open a store on a fresh file with one activated Workspace.
 *
 * Every Space query is Workspace-scoped, so a store with no active Workspace
 * refuses — the same way a Disk adapter refuses before a workspace path is
 * committed. Tests get one activated Workspace so they can address Spaces
 * without repeating the lifecycle.
 */
export async function openEmptySqliteTestStore(
  prefix = 'huabu-sqlite-empty-',
  now?: () => number,
): Promise<EmptySqliteTestStore> {
  const file = createSqliteTestFile(prefix);
  const context = new SqliteStoreContext(file.filename, now);
  const store = new SqliteStructuredStore(context);
  try {
    context.init();
    const workspace = await new SqliteWorkspaceRepository(context).create(
      SQLITE_TEST_WORKSPACE_NAME,
    );
    context.useWorkspace(workspace.workspaceId);
    return {
      ...file,
      store,
      context,
      workspaceId: workspace.workspaceId,
      closeConnection: () => context.close(),
      cleanup: async () => {
        context.close();
        file.remove();
      },
    };
  } catch (error) {
    context.close();
    file.remove();
    throw error;
  }
}

export async function openSqliteTestStore(
  prefix = 'huabu-sqlite-',
  now?: () => number,
): Promise<OpenSqliteTestStore> {
  const opened = await openEmptySqliteTestStore(prefix, now);
  try {
    const world = seedSqliteWorld(opened.filename, opened.workspaceId);
    return { ...opened, world };
  } catch (error) {
    await opened.cleanup();
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
