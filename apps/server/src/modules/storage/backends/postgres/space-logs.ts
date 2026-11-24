// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spaceRowExists } from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { stringifyJson } from '../sql/codecs.js';
import {
  decodeChanges,
  decodeEvents,
  encodeEventBatch,
  mergeChangesRow,
  SELECT_CHANGES,
  UPSERT_CHANGES,
} from '../sql/log-rules.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type {
  NewCanvasEvent,
  SpaceChanges,
  SpaceEvents,
} from '../../ports/structured.js';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

async function requireSpace(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
): Promise<void> {
  if (!(await spaceRowExists(database, workspaceId, canvasId))) {
    throw new Error(
      `Postgres Space logs(${canvasId}) cannot mutate a missing Space`,
    );
  }
}

/**
 * Fold `records` into one thread's coalesced Review list, inside the caller's
 * transaction, and return the list as stored.
 *
 * The one place the list is read, coalesced and replaced: `changes.append`
 * runs it in a transaction of its own, the Space write runs it in the
 * transaction that also replaces the record. The caller has validated the
 * thread id and that the Space exists.
 */
export async function appendPostgresChangesInTransaction(
  database: PgExecutor,
  canvasId: string,
  threadId: string,
  records: readonly CanvasChangeRecord[],
): Promise<CanvasChangeRecord[]> {
  const { merged, params } = mergeChangesRow(
    await database.get(SELECT_CHANGES, canvasId, threadId),
    canvasId,
    threadId,
    records,
  );
  await database.run(UPSERT_CHANGES, ...params);
  return merged;
}

export interface PostgresSpaceLogs {
  readonly events: SpaceEvents;
  readonly changes: SpaceChanges;
}

class PostgresSpaceLogCoordinator {
  readonly #context: PostgresStoreContext;
  readonly #workspaceId: string;
  readonly #canvasId: string;

  constructor(
    context: PostgresStoreContext,
    workspaceId: string,
    canvasId: string,
  ) {
    this.#context = context;
    this.#workspaceId = workspaceId;
    this.#canvasId = canvasId;
  }

  #workspace(): string {
    return this.#context.assertBoundWorkspace(
      this.#workspaceId,
      `Postgres Space logs(${this.#canvasId})`,
    );
  }

  async readEvents(limit?: number): Promise<CanvasEvent[]> {
    this.#workspace();
    const database = this.#context.database();
    if (!(await spaceRowExists(database, this.#workspaceId, this.#canvasId)))
      return [];
    return decodeEvents(
      await database.all(
        `SELECT event_json
         FROM events
         WHERE canvas_id = ?
         ORDER BY event_id ASC`,
        this.#canvasId,
      ),
      limit,
    );
  }

  async appendEvents(events: readonly NewCanvasEvent[]): Promise<void> {
    this.#context.assertOpen();
    const workspaceId = this.#workspace();
    if (events.length === 0) return;
    const records = encodeEventBatch(events, () => this.#context.now());
    this.#context.assertMutationAllowed(this.#canvasId);
    await this.#context.transaction(async (database) => {
      await requireSpace(database, workspaceId, this.#canvasId);
      for (const record of records) {
        await database.run(
          'INSERT INTO events (canvas_id, event_json) VALUES (?, ?)',
          this.#canvasId,
          record,
        );
      }
    });
  }

  async readChanges(threadIdInput: string): Promise<CanvasChangeRecord[]> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    this.#workspace();
    if (
      !(await spaceRowExists(
        this.#context.database(),
        this.#workspaceId,
        this.#canvasId,
      ))
    )
      return [];
    const row = await this.#context.database().get(
      `SELECT snapshot_json
         FROM changes
         WHERE canvas_id = ? AND thread_id = ?`,
      this.#canvasId,
      threadId,
    );
    return row === undefined
      ? []
      : decodeChanges(row['snapshot_json'], this.#canvasId, threadId);
  }

  async appendChanges(
    threadIdInput: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    stringifyJson(records, `Changes for thread ${JSON.stringify(threadId)}`);
    this.#context.assertMutationAllowed(this.#canvasId);
    const workspaceId = this.#workspace();
    return await this.#context.transaction(async (database) => {
      await requireSpace(database, workspaceId, this.#canvasId);
      return appendPostgresChangesInTransaction(
        database,
        this.#canvasId,
        threadId,
        records,
      );
    });
  }

  async deleteChange(
    threadIdInput: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    this.#context.assertMutationAllowed(this.#canvasId);
    const workspaceId = this.#workspace();
    return await this.#context.transaction(async (database) => {
      await requireSpace(database, workspaceId, this.#canvasId);
      const current = await database.get(
        `SELECT snapshot_json
           FROM changes
           WHERE canvas_id = ? AND thread_id = ?`,
        this.#canvasId,
        threadId,
      );
      if (current === undefined) return null;
      const existing = decodeChanges(
        current['snapshot_json'],
        this.#canvasId,
        threadId,
      );
      const index = existing.findIndex((record) => record.id === changeId);
      if (index < 0) return null;
      const [removed] = existing.splice(index, 1);
      await database.run(
        `UPDATE changes
           SET snapshot_json = ?
           WHERE canvas_id = ? AND thread_id = ?`,
        stringifyJson(existing, `Changes for thread ${threadId}`),
        this.#canvasId,
        threadId,
      );
      return removed ?? null;
    });
  }
}

export function createPostgresSpaceLogs(
  context: PostgresStoreContext,
  workspaceId: string,
  canvasId: string,
): PostgresSpaceLogs {
  const coordinator = new PostgresSpaceLogCoordinator(
    context,
    workspaceId,
    canvasId,
  );
  return Object.freeze({
    events: Object.freeze({
      read: (limit?: number) => coordinator.readEvents(limit),
      append: (events: readonly NewCanvasEvent[]) =>
        coordinator.appendEvents(events),
    }),
    changes: Object.freeze({
      read: (threadId: string) => coordinator.readChanges(threadId),
      append: (threadId: string, records: readonly CanvasChangeRecord[]) =>
        coordinator.appendChanges(threadId, records),
      delete: (threadId: string, changeId: string) =>
        coordinator.deleteChange(threadId, changeId),
    }),
  });
}
