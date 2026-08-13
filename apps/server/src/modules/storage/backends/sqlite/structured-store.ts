// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SqliteStoreContext } from './database.js';
import { createSqliteSpaceLogs } from './space-logs.js';
import { SqliteSpaceNodes } from './space-nodes.js';
import { SqliteSpaceRepository } from './space-repository.js';
import { SqliteSpaceTasks } from './space-tasks.js';
import { createSqliteSpaceWrite } from './space-write.js';
import { readSpaceRow } from './values.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { StorageHealth } from '../../ports/common.js';
import type {
  SpaceHandle,
  SpaceRepository,
  StructuredStore,
} from '../../ports/structured.js';

/** Production structured-store adapter backed by one node:sqlite connection. */
export class SqliteStructuredStore implements StructuredStore {
  readonly kind = 'sqlite' as const;

  readonly #context: SqliteStoreContext;

  constructor(filename: string, now: () => number = Date.now) {
    if (typeof filename !== 'string') {
      throw new TypeError('SQLite filename must be a string');
    }
    if (filename.length === 0) {
      throw new TypeError('SQLite filename must not be empty');
    }
    this.#context = new SqliteStoreContext(filename, now);
  }

  async init(): Promise<void> {
    this.#context.init();
  }

  async health(): Promise<StorageHealth> {
    return this.#context.health(this.kind);
  }

  async close(): Promise<void> {
    this.#context.close();
  }

  spaces(): SpaceRepository {
    return Object.freeze(new SqliteSpaceRepository(this.#context));
  }

  space(canvasIdInput: string): SpaceHandle {
    const canvasId = sanitizeId(canvasIdInput, 'canvasId');
    const { events, changes } = createSqliteSpaceLogs(this.#context, canvasId);
    const nodes = Object.freeze(new SqliteSpaceNodes(this.#context, canvasId));
    const tasks = Object.freeze(new SqliteSpaceTasks(this.#context, canvasId));
    return Object.freeze({
      canvasId,
      read: async () =>
        readSpaceRow(this.#context.database(), canvasId)?.record ?? null,
      write: createSqliteSpaceWrite(this.#context, canvasId),
      nodes,
      changes,
      tasks,
      events,
    });
  }
}
