// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SqliteStoreContext } from './database.js';
import { readSpaceRow } from './rows.js';
import {
  createSqliteSpaceExtension,
  resolveSqliteSpaceExtension,
} from './space-extension.js';
import { createSqliteSpaceLogs } from './space-logs.js';
import { SqliteSpaceNodes } from './space-nodes.js';
import { SqliteSpaceRepository } from './space-repository.js';
import { SqliteSpaceTasks } from './space-tasks.js';
import { createSqliteSpaceWrite } from './space-write.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteSpaceSubstrate } from './space-extension.js';
import type { StorageHealth } from '../../ports/common.js';
import type {
  SpaceHandle,
  SpaceRepository,
  StructuredStore,
} from '../../ports/structured.js';

/**
 * Structured-store adapter over one `node:sqlite` connection.
 *
 * The connection is shared with the Workspace repository — one database file
 * cannot have two writers — so this class does not assume it owns the
 * lifecycle. Constructed with a filename it opens and closes its own
 * connection; constructed with an existing context it borrows one, and
 * `init`/`close` become the shared owner's business.
 */
export class SqliteStructuredStore implements StructuredStore {
  readonly kind = 'sqlite' as const;

  readonly #context: SqliteStoreContext;
  readonly #ownsContext: boolean;

  constructor(
    source: string | SqliteStoreContext,
    now: () => number = Date.now,
  ) {
    if (source instanceof SqliteStoreContext) {
      this.#context = source;
      this.#ownsContext = false;
      return;
    }
    if (typeof source !== 'string') {
      throw new TypeError('SQLite filename must be a string');
    }
    if (source.length === 0) {
      throw new TypeError('SQLite filename must not be empty');
    }
    this.#context = new SqliteStoreContext(source, now);
    this.#ownsContext = true;
  }

  /** The shared connection, for composition that wires a second port on it. */
  get context(): SqliteStoreContext {
    return this.#context;
  }

  async init(): Promise<void> {
    if (this.#ownsContext) this.#context.init();
    else this.#context.assertOpen();
  }

  async health(): Promise<StorageHealth> {
    return this.#context.health(this.kind);
  }

  async close(): Promise<void> {
    if (this.#ownsContext) this.#context.close();
  }

  spaces(): SpaceRepository {
    return Object.freeze(new SqliteSpaceRepository(this.#context));
  }

  /**
   * The synchronous form of `space(canvasId).extension(namespace)`.
   *
   * Off the port on purpose: it is a SQLite capability, and the composition
   * root hands it to owners the same way it hands out `diskTree` — named for
   * the backend that has it, absent everywhere else.
   */
  extensionSync(
    canvasIdInput: string,
    namespace: string,
  ): SqliteSpaceSubstrate | null {
    const canvasId = sanitizeId(canvasIdInput, 'canvasId');
    return resolveSqliteSpaceExtension(
      this.#context,
      this.#context.workspaceId(),
      canvasId,
      namespace,
    );
  }

  space(canvasIdInput: string): SpaceHandle {
    const canvasId = sanitizeId(canvasIdInput, 'canvasId');
    // Bound once, here, so every part of this handle answers for the same
    // Workspace and a switch invalidates all of them together.
    const workspaceId = this.#context.workspaceId();
    const { events, changes } = createSqliteSpaceLogs(
      this.#context,
      workspaceId,
      canvasId,
    );
    const nodes = Object.freeze(
      new SqliteSpaceNodes(this.#context, workspaceId, canvasId),
    );
    const tasks = Object.freeze(
      new SqliteSpaceTasks(this.#context, workspaceId, canvasId),
    );
    return Object.freeze({
      canvasId,
      read: async () => {
        this.#context.assertBoundWorkspace(
          workspaceId,
          `SQLite Space(${canvasId})`,
        );
        return (
          readSpaceRow(this.#context.database(), workspaceId, canvasId)
            ?.record ?? null
        );
      },
      write: createSqliteSpaceWrite(this.#context, workspaceId, canvasId),
      nodes,
      changes,
      tasks,
      events,
      extension: createSqliteSpaceExtension(
        this.#context,
        workspaceId,
        canvasId,
      ),
    });
  }
}
