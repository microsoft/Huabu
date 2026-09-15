// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The one SQLite connection a process holds, and the state that lives as long
 * as it does.
 *
 * The structured store and the Workspace repository share this object. That is
 * not a convenience: they are one database file, so two connections would be
 * two writers to it, and SQLite's answer to that is a lock error rather than a
 * queue. One connection also makes the ordered Space write a real transaction
 * across everything it touches.
 *
 * The active Workspace is held here for the same reason the Disk adapters hold
 * the active workspace path: it is the namespace every query is scoped to.
 * Switching Workspaces re-points this field and reopens nothing — the settled
 * "Backend selection scope" decision in proposal §2.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_MIGRATIONS, type SqliteMigration } from './schema.js';
import { getDataDir } from '../../../../data-dir.js';
import {
  assertSpaceMutationAllowed,
  beginSpaceDeleteAdmission,
} from '../../space-lifecycle-admission.js';

import type { StorageHealth } from '../../ports/common.js';

export { SQLITE_MIGRATIONS, SQLITE_SCHEMA_VERSION } from './schema.js';
export type { SqliteMigration } from './schema.js';

/**
 * The collision key the hidden World Space is filed under.
 *
 * Unreachable from any user title: `toSafeFilename` strips leading dots, so
 * no requested name normalizes to it and the World slot cannot be taken by
 * an ordinary Space.
 */
export const SQLITE_WORLD_COLLISION_KEY = '.world';

/** Milliseconds a statement waits for a lock before reporting SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Where this backend keeps its records in the Server data directory.
 *
 * One file, under a directory named for the backend the way
 * `storage/disk/` names the other one, so an operator finds both in the same
 * place. `HUABU_SQLITE_PATH` replaces it for a deployment that keeps its
 * database elsewhere.
 *
 * Records only. A Space's *bytes* are the blob axis's business wherever this
 * backend is selected, and this backend never learns where they went — see
 * `backends/disk/data-dir.ts`.
 */
export function sqliteDatabasePath(dataDir: string = getDataDir()): string {
  const configured = process.env['HUABU_SQLITE_PATH']?.trim();
  if (configured) return configured;
  return path.join(dataDir, 'storage', 'sqlite', 'huabu.sqlite');
}

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

/** Raised when a handle outlives the Workspace it was resolved in. */
export class SqliteWorkspaceScopeError extends Error {
  override name = 'SqliteWorkspaceScopeError';
}

/** One connection and all adapter-lifetime process-local state. */
export class SqliteStoreContext {
  readonly now: () => number;

  readonly #database: DatabaseSync;
  readonly #filename: string;
  readonly #admissionScope: string;
  #state: 'new' | 'open' | 'closed' = 'new';
  #workspaceId: string | null = null;

  constructor(filename: string, now: () => number = Date.now) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('SQLite filename must be a non-empty string');
    }
    this.now = now;
    this.#filename = filename;
    this.#admissionScope = `sqlite:${filename}`;
    this.#database = new DatabaseSync(filename, { open: false });
  }

  get filename(): string {
    return this.#filename;
  }

  init(): void {
    if (this.#state === 'open') return;
    if (this.#state === 'closed') {
      throw new Error('SQLite store is closed');
    }

    try {
      // A database file names a directory that may not exist yet — the whole
      // point of this profile is that the operator never had to create one.
      // In-memory and URI filenames name no directory at all.
      const directory = path.dirname(this.#filename);
      if (
        !this.#filename.startsWith(':') &&
        !this.#filename.startsWith('file:')
      ) {
        mkdirSync(directory, { recursive: true });
      }
      this.#database.open();
      // Write-ahead logging so a reader is never blocked by the writer, and a
      // bounded wait so a second connection (an external tool, a stale
      // process) reports a busy database instead of failing instantly.
      this.#database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.#database.exec('PRAGMA journal_mode = WAL');
      // NORMAL is the documented pairing for WAL: durable across a process
      // crash, and only a machine-level crash can lose the most recent
      // commits — which is the same guarantee the Disk adapter's atomic
      // renames give, stated rather than assumed.
      this.#database.exec('PRAGMA synchronous = NORMAL');
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

  // ─── The active Workspace ────────────────────────────────────────────────

  /** Point every subsequent query at one Workspace. Reopens nothing. */
  useWorkspace(workspaceId: string | null): void {
    this.#workspaceId = workspaceId;
  }

  /** The active Workspace id, or `null` when none has been selected. */
  activeWorkspaceId(): string | null {
    return this.#workspaceId;
  }

  /** The active Workspace id, or a refusal when none has been selected. */
  workspaceId(): string {
    this.assertOpen();
    if (this.#workspaceId === null) {
      throw new SqliteWorkspaceScopeError(
        'No Workspace is active on the SQLite backend. Activate one before ' +
          'reading or writing Spaces.',
      );
    }
    return this.#workspaceId;
  }

  /**
   * The Workspace a retained handle was resolved in, or a refusal.
   *
   * A handle keeps the id it was built with and re-checks it here, so a
   * Workspace switch makes the stale handle reject rather than silently
   * addressing rows in the newly active namespace. That is the same rule the
   * Disk adapters apply to a retained workspace path.
   */
  assertBoundWorkspace(boundWorkspaceId: string, what: string): string {
    const active = this.workspaceId();
    if (active !== boundWorkspaceId) {
      throw new SqliteWorkspaceScopeError(
        `${what} belongs to an inactive Workspace. Resolve a fresh handle ` +
          'after Workspace activation.',
      );
    }
    return active;
  }

  // ─── Space lifecycle admission ───────────────────────────────────────────

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
