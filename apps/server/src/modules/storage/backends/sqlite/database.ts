// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { DatabaseSync } from 'node:sqlite';

import {
  assertSpaceMutationAllowed,
  beginSpaceDeleteAdmission,
} from '../../space-lifecycle-admission.js';

import type { StorageHealth } from '../../ports/common.js';

export const SQLITE_SCHEMA_VERSION = 1;
export const SQLITE_WORLD_COLLISION_KEY = '.world';

const SCHEMA_V1 = `
  CREATE TABLE spaces (
    canvas_id TEXT PRIMARY KEY,
    title TEXT,
    collision_key TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    is_world INTEGER NOT NULL DEFAULT 0 CHECK (is_world IN (0, 1))
  ) STRICT;

  CREATE UNIQUE INDEX spaces_single_world
    ON spaces(is_world)
    WHERE is_world = 1;

  CREATE TABLE nodes (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    revision TEXT NOT NULL CHECK (length(revision) > 0),
    label_collision_key TEXT NOT NULL,
    PRIMARY KEY (canvas_id, node_id),
    UNIQUE (canvas_id, label_collision_key),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX events_by_canvas_order
    ON events(canvas_id, event_id);

  CREATE TABLE changes (
    canvas_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    PRIMARY KEY (canvas_id, thread_id),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE tasks (
    canvas_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE space_extensions (
    extension_id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    UNIQUE (canvas_id, namespace),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE delta_log (
    canvas_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
    PRIMARY KEY (canvas_id, version),
    FOREIGN KEY (canvas_id) REFERENCES spaces(canvas_id) ON DELETE CASCADE
  ) STRICT;
`;

export interface SqliteMigration {
  readonly version: number;
  readonly sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  Object.freeze({ version: 1, sql: SCHEMA_V1 }),
]);

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  const version = row?.['user_version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new Error('SQLite returned an invalid PRAGMA user_version');
  }
  return version;
}

export function applySqliteMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const expectedVersion = index + 1;
    if (migrations[index]?.version !== expectedVersion) {
      throw new Error(
        `SQLite migrations must be contiguous from version 1; expected ${expectedVersion}`,
      );
    }
  }
  const targetVersion = migrations.at(-1)?.version ?? 0;
  const current = readUserVersion(database);
  if (current > targetVersion) {
    throw new Error(
      `SQLite schema version ${current} is newer than supported version ${targetVersion}`,
    );
  }
  if (current === targetVersion) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    let version = readUserVersion(database);
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      if (migration.version !== version + 1) {
        throw new Error(
          `No SQLite migration path from schema version ${version} to ${targetVersion}`,
        );
      }
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      version = migration.version;
    }
    if (version !== targetVersion) {
      throw new Error(
        `No SQLite migration path from schema version ${version} to ${targetVersion}`,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

/** One connection and all adapter-lifetime process-local state. */
export class SqliteStoreContext {
  readonly now: () => number;

  readonly #database: DatabaseSync;
  readonly #admissionScope: string;
  #state: 'new' | 'open' | 'closed' = 'new';

  constructor(filename: string, now: () => number) {
    this.now = now;
    this.#admissionScope = `sqlite:${filename}`;
    this.#database = new DatabaseSync(filename, { open: false });
  }

  init(): void {
    if (this.#state === 'open') return;
    if (this.#state === 'closed') {
      throw new Error('SQLite store is closed');
    }

    try {
      this.#database.open();
      this.#database.exec('PRAGMA foreign_keys = ON');
      const foreignKeys = this.#database.prepare('PRAGMA foreign_keys').get()?.[
        'foreign_keys'
      ];
      if (foreignKeys !== 1) {
        throw new Error('Could not enable SQLite foreign key enforcement');
      }
      applySqliteMigrations(this.#database);
      this.#state = 'open';
    } catch (error) {
      if (this.#database.isOpen) this.#database.close();
      this.#state = 'closed';
      throw error;
    }
  }

  health(kind: string): StorageHealth {
    this.assertOpen();
    try {
      const value = this.#database.prepare('SELECT 1 AS ok').get()?.['ok'];
      return value === 1
        ? { ok: true, kind }
        : { ok: false, kind, detail: 'SQLite liveness query returned no row' };
    } catch (error) {
      return {
        ok: false,
        kind,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    if (this.#database.isOpen) this.#database.close();
  }

  database(): DatabaseSync {
    this.assertOpen();
    return this.#database;
  }

  assertOpen(): void {
    if (this.#state !== 'open') {
      throw new Error(
        this.#state === 'closed'
          ? 'SQLite store is closed'
          : 'SQLite store is not initialized',
      );
    }
  }

  assertMutationAllowed(canvasId: string): void {
    this.assertOpen();
    assertSpaceMutationAllowed(this.#admissionScope, canvasId);
  }

  async acquireDelete(canvasId: string): Promise<() => void> {
    this.assertOpen();
    const releaseGate = await beginSpaceDeleteAdmission(
      this.#admissionScope,
      canvasId,
    );
    try {
      this.assertOpen();
    } catch (error) {
      releaseGate();
      throw error;
    }
    return releaseGate;
  }
}

export function withImmediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
