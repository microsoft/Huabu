// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  WORKSPACE_COLUMNS,
  decodeWorkspaceRow,
  requireName,
} from '../sql/workspace-rules.js';
/**
 * Postgres implementation of the Workspace storage port.
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

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from '../../ports/workspace.js';

async function readWorkspaceRow(
  database: PgExecutor,
  workspaceId: string,
): Promise<WorkspaceHandle | null> {
  const row = await database.get(
    `SELECT ${WORKSPACE_COLUMNS}
       FROM workspaces
       WHERE workspace_id = ? AND forgotten_at IS NULL`,
    workspaceId,
  );
  return row === undefined ? null : decodeWorkspaceRow(row);
}

async function insertWorkspaceRow(
  database: PgExecutor,
  workspaceId: string,
  name: string,
  timestamp: number,
): Promise<void> {
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('Postgres Workspace clock returned a non-finite value');
  }
  await database.run(
    `INSERT INTO workspaces (
         workspace_id, name, created_at, last_opened_at, forgotten_at
       ) VALUES (?, ?, ?, ?, NULL)`,
    workspaceId,
    name,
    timestamp,
    timestamp,
  );
}

async function markOpenedIn(
  database: PgExecutor,
  workspaceId: string,
  timestamp: number,
): Promise<void> {
  await database.run(
    'UPDATE workspaces SET last_opened_at = ? WHERE workspace_id = ?',
    timestamp,
    workspaceId,
  );
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  readonly #context: PostgresStoreContext;

  constructor(context: PostgresStoreContext) {
    this.#context = context;
  }

  async get(workspaceId: string): Promise<WorkspaceHandle | null> {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return null;
    }
    return await readWorkspaceRow(this.#context.database(), workspaceId);
  }

  async list(): Promise<readonly WorkspaceHandle[]> {
    // Most recently opened first, matching the Disk registry's ordering, so a
    // client rendering the picker gets the same list on either backend.
    return (
      await this.#context.database().all(`SELECT ${WORKSPACE_COLUMNS}
         FROM workspaces
         WHERE forgotten_at IS NULL
         ORDER BY last_opened_at DESC, created_at DESC`)
    ).map(decodeWorkspaceRow);
  }

  async rename(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceHandle | null> {
    const trimmed = requireName(name);
    return await this.#context.transaction(async (database) => {
      if ((await readWorkspaceRow(database, workspaceId)) === null) return null;
      await database.run(
        `UPDATE workspaces
           SET name = ?
           WHERE workspace_id = ? AND forgotten_at IS NULL`,
        trimmed,
        workspaceId,
      );
      return await readWorkspaceRow(database, workspaceId);
    });
  }

  async remove(workspaceId: string): Promise<boolean> {
    return await this.#context.transaction(async (database) => {
      if ((await readWorkspaceRow(database, workspaceId)) === null)
        return false;
      await database.run(
        'UPDATE workspaces SET forgotten_at = ? WHERE workspace_id = ?',
        this.#context.now(),
        workspaceId,
      );
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
    await insertWorkspaceRow(
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
    return await this.#context.transaction(async (database) => {
      const existing = await database.get(`SELECT ${WORKSPACE_COLUMNS}
           FROM workspaces
           WHERE forgotten_at IS NULL
           ORDER BY last_opened_at DESC, created_at DESC
           LIMIT 1`);
      if (existing !== undefined) {
        const workspace = decodeWorkspaceRow(existing);
        await markOpenedIn(
          database,
          workspace.workspaceId,
          this.#context.now(),
        );
        return workspace;
      }
      const workspaceId = randomUUID();
      await insertWorkspaceRow(
        database,
        workspaceId,
        trimmed,
        this.#context.now(),
      );
      return { workspaceId, name: trimmed };
    });
  }

  /** Record that a Workspace was activated, for recency ordering. */
  async markOpened(workspaceId: string): Promise<void> {
    await markOpenedIn(
      this.#context.database(),
      workspaceId,
      this.#context.now(),
    );
  }
}
