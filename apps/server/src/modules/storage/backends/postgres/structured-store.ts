// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PostgresStoreContext } from './database.js';
import { readSpaceRow, spaceRowExists } from './rows.js';
import { createPostgresSpaceLogs } from './space-logs.js';
import { PostgresSpaceNodes } from './space-nodes.js';
import { PostgresSpaceRepository } from './space-repository.js';
import { PostgresSpaceTasks } from './space-tasks.js';
import { createPostgresSpaceWrite } from './space-write.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { assertValidNamespace } from '../../ports/namespace.js';

import type { SpaceHandle, StructuredStore } from '../../ports/structured.js';
import type { PoolConfig } from 'pg';

/** The async Postgres adapter behind the `postgres` structured profile. */
export class PostgresStructuredStore implements StructuredStore {
  readonly kind = 'postgres' as const;
  readonly context: PostgresStoreContext;
  readonly #ownsContext: boolean;
  constructor(
    source: PoolConfig | PostgresStoreContext,
    now: () => number = Date.now,
  ) {
    this.#ownsContext = !(source instanceof PostgresStoreContext);
    this.context =
      source instanceof PostgresStoreContext
        ? source
        : new PostgresStoreContext(source, now);
  }
  async init(): Promise<void> {
    await this.context.init();
  }
  async close(): Promise<void> {
    if (this.#ownsContext) await this.context.close();
  }
  async health() {
    return this.context.health();
  }
  spaces() {
    return new PostgresSpaceRepository(this.context);
  }
  space(canvasIdInput: string): SpaceHandle {
    const canvasId = sanitizeId(canvasIdInput, 'canvasId');
    const context = this.context;
    const workspaceId = context.workspaceId();
    const guard = () =>
      context.assertBoundWorkspace(workspaceId, `Space(${canvasId})`);
    return Object.freeze({
      canvasId,
      read: async () => {
        guard();
        return (
          (await readSpaceRow(context.database(), workspaceId, canvasId))
            ?.record ?? null
        );
      },
      write: createPostgresSpaceWrite(context, workspaceId, canvasId),
      nodes: new PostgresSpaceNodes(context, workspaceId, canvasId),
      tasks: new PostgresSpaceTasks(context, workspaceId, canvasId),
      ...createPostgresSpaceLogs(context, workspaceId, canvasId),
      extension: async (input: string) => {
        const namespace = assertValidNamespace(input);
        guard();
        context.assertMutationAllowed(canvasId);
        return context.transaction(async (database) => {
          if (!(await spaceRowExists(database, workspaceId, canvasId)))
            return null;
          // Look up before inserting: an upsert draws an identity value on
          // every call, and memory reads resolve their namespace each turn.
          // The transaction's write lock makes lookup-then-insert race-free.
          const row =
            (await database.get(
              'SELECT extension_id FROM space_extensions WHERE canvas_id = ? AND namespace = ?',
              canvasId,
              namespace,
            )) ??
            (await database.get(
              'INSERT INTO space_extensions (canvas_id, namespace) VALUES (?, ?) RETURNING extension_id',
              canvasId,
              namespace,
            ));
          const extensionId = row?.['extension_id'];
          if (typeof extensionId !== 'number')
            throw new Error('Invalid Postgres extension id');
          return {
            kind: 'postgres' as const,
            database: context.connection(),
            extensionId,
          };
        });
      },
    });
  }
}
