// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite implementation of the Workspace storage port.
 *
 * A Workspace here is a row, not a folder. That is the whole difference
 * between this adapter and the Disk one, and it is why selecting a SQL profile
 * asks the operator for no directory: the port never promised a location, only
 * an identity and a name (`ports/workspace.ts`), and the Disk repository's
 * path index is a materialization fact that lives beside it rather than in it.
 *
 * `remove()` is a **forget**, not a delete. The port's wording is deliberate —
 * "forget one member without deleting any Workspace-owned data" — and on Disk
 * that is easy to honour because the folder outlives the registry entry. A
 * database has no such second copy, so forgetting is recorded as a timestamp
 * and the rows stay: a listing skips them, and nothing a user authored is
 * destroyed by an operation whose name does not say "delete".
 */

import { randomUUID } from 'node:crypto';

import { withImmediateTransaction } from './database.js';

import type { SqliteStoreContext } from './database.js';
import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from '../../ports/workspace.js';
import type { DatabaseSync } from 'node:sqlite';

const WORKSPACE_COLUMNS = 'workspace_id, name, created_at, last_opened_at';

function decodeWorkspaceRow(value: unknown): WorkspaceHandle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Malformed persisted SQLite Workspace row');
  }
  const row = value as Record<string, unknown>;
  const workspaceId = row['workspace_id'];
  const name = row['name'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new SyntaxError('Invalid workspace_id in persisted SQLite Workspace');
  }
  if (typeof name !== 'string') {
    throw new SyntaxError('Invalid name in persisted SQLite Workspace');
  }
  return { workspaceId, name };
}

function requireName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new TypeError('Workspace name must be a string');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TypeError('Workspace name must not be empty');
  }
  return trimmed;
}

function readWorkspaceRow(
  database: DatabaseSync,
  workspaceId: string,
): WorkspaceHandle | null {
  const row = database
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS}
       FROM workspaces
       WHERE workspace_id = ? AND forgotten_at IS NULL`,
    )
    .get(workspaceId);
  return row === undefined ? null : decodeWorkspaceRow(row);
}

function insertWorkspaceRow(
  database: DatabaseSync,
  workspaceId: string,
  name: string,
  timestamp: number,
): void {
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('SQLite Workspace clock returned a non-finite value');
  }
  database
    .prepare(
      `INSERT INTO workspaces (
         workspace_id, name, created_at, last_opened_at, forgotten_at
       ) VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(workspaceId, name, timestamp, timestamp);
}

function markOpenedIn(
  database: DatabaseSync,
  workspaceId: string,
  timestamp: number,
): void {
  database
    .prepare('UPDATE workspaces SET last_opened_at = ? WHERE workspace_id = ?')
    .run(timestamp, workspaceId);
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  readonly #context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.#context = context;
  }

  async get(workspaceId: string): Promise<WorkspaceHandle | null> {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return null;
    }
    return readWorkspaceRow(this.#context.database(), workspaceId);
  }

  async list(): Promise<readonly WorkspaceHandle[]> {
    // Most recently opened first, matching the Disk registry's ordering, so a
    // client rendering the picker gets the same list on either backend.
    return this.#context
      .database()
      .prepare(
        `SELECT ${WORKSPACE_COLUMNS}
         FROM workspaces
         WHERE forgotten_at IS NULL
         ORDER BY last_opened_at DESC, created_at DESC`,
      )
      .all()
      .map(decodeWorkspaceRow);
  }

  async rename(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceHandle | null> {
    const trimmed = requireName(name);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      if (readWorkspaceRow(database, workspaceId) === null) return null;
      database
        .prepare(
          `UPDATE workspaces
           SET name = ?
           WHERE workspace_id = ? AND forgotten_at IS NULL`,
        )
        .run(trimmed, workspaceId);
      return readWorkspaceRow(database, workspaceId);
    });
  }

  async remove(workspaceId: string): Promise<boolean> {
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      if (readWorkspaceRow(database, workspaceId) === null) return false;
      database
        .prepare(
          'UPDATE workspaces SET forgotten_at = ? WHERE workspace_id = ?',
        )
        .run(this.#context.now(), workspaceId);
      return true;
    });
  }

  // ─── Beyond the port ─────────────────────────────────────────────────────
  //
  // Creating a Workspace and recording that one was opened are lifecycle
  // operations the port deliberately leaves out: on Disk they are "adopt this
  // directory", which is a materialization fact. They are named for what this
  // backend actually does instead of being bent into the shared shape.

  /** Register a new Workspace and return its identity. */
  async create(name: string): Promise<WorkspaceHandle> {
    const trimmed = requireName(name);
    const workspaceId = randomUUID();
    insertWorkspaceRow(
      this.#context.database(),
      workspaceId,
      trimmed,
      this.#context.now(),
    );
    return { workspaceId, name: trimmed };
  }

  /**
   * The Workspace a fresh deployment starts in.
   *
   * A database nobody has opened before holds no Workspace, and a Server with
   * no Workspace has nothing to show. The Disk profile answers this by asking
   * the user for a folder; a SQL profile has nothing to ask for, so it starts
   * one. Idempotent, and narrower than "create if absent": it mints a
   * Workspace only when the database holds none at all, so forgetting the last
   * one does not silently mint a second.
   */
  async ensureDefault(name: string): Promise<WorkspaceHandle> {
    const trimmed = requireName(name);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      const existing = database
        .prepare(
          `SELECT ${WORKSPACE_COLUMNS}
           FROM workspaces
           WHERE forgotten_at IS NULL
           ORDER BY last_opened_at DESC, created_at DESC
           LIMIT 1`,
        )
        .get();
      if (existing !== undefined) {
        const workspace = decodeWorkspaceRow(existing);
        markOpenedIn(database, workspace.workspaceId, this.#context.now());
        return workspace;
      }
      const workspaceId = randomUUID();
      insertWorkspaceRow(database, workspaceId, trimmed, this.#context.now());
      return { workspaceId, name: trimmed };
    });
  }

  /** Record that a Workspace was activated, for recency ordering. */
  markOpened(workspaceId: string): void {
    markOpenedIn(this.#context.database(), workspaceId, this.#context.now());
  }
}
