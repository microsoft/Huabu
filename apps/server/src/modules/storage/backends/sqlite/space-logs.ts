// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { withImmediateTransaction } from './database.js';
import { spaceRowExists } from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { stringifyJson } from '../sql/codecs.js';
import {
  decodeChanges,
  decodeEvents,
  encodeEventBatch,
} from '../sql/log-rules.js';

import type { SqliteStoreContext } from './database.js';
import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type {
  NewCanvasEvent,
  SpaceChanges,
  SpaceEvents,
} from '../../ports/structured.js';
import type { DatabaseSync } from 'node:sqlite';

function requireSpace(
  context: SqliteStoreContext,
  workspaceId: string,
  canvasId: string,
): void {
  context.assertMutationAllowed(canvasId);
  if (!spaceRowExists(context.database(), workspaceId, canvasId)) {
    throw new Error(
      `SQLite Space logs(${canvasId}) cannot mutate a missing Space`,
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
export function appendSqliteChangesInTransaction(
  database: DatabaseSync,
  canvasId: string,
  threadId: string,
  records: readonly CanvasChangeRecord[],
): CanvasChangeRecord[] {
  if (!database.isTransaction)
    throw new Error('Appending changes requires a transaction');
  const current = database
    .prepare(
      `SELECT snapshot_json
       FROM changes
       WHERE canvas_id = ? AND thread_id = ?`,
    )
    .get(canvasId, threadId);
  const existing =
    current === undefined
      ? []
      : decodeChanges(current['snapshot_json'], canvasId, threadId);
  const merged = coalesceChanges([...existing, ...records]);
  database
    .prepare(
      `INSERT INTO changes (canvas_id, thread_id, snapshot_json)
       VALUES (?, ?, ?)
       ON CONFLICT(canvas_id, thread_id) DO UPDATE SET
         snapshot_json = excluded.snapshot_json`,
    )
    .run(
      canvasId,
      threadId,
      stringifyJson(merged, `Changes for thread ${threadId}`),
    );
  return merged;
}

export interface SqliteSpaceLogs {
  readonly events: SpaceEvents;
  readonly changes: SpaceChanges;
}

class SqliteSpaceLogCoordinator {
  readonly #context: SqliteStoreContext;
  readonly #workspaceId: string;
  readonly #canvasId: string;

  constructor(
    context: SqliteStoreContext,
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
      `SQLite Space logs(${this.#canvasId})`,
    );
  }

  async readEvents(limit?: number): Promise<CanvasEvent[]> {
    this.#workspace();
    const database = this.#context.database();
    return decodeEvents(
      database
        .prepare(
          `SELECT event_json
         FROM events
         WHERE canvas_id = ?
         ORDER BY event_id ASC`,
        )
        .all(this.#canvasId),
      limit,
    );
  }

  async appendEvents(events: readonly NewCanvasEvent[]): Promise<void> {
    this.#context.assertOpen();
    const workspaceId = this.#workspace();
    if (events.length === 0) return;
    const records = encodeEventBatch(events, () => this.#context.now());

    requireSpace(this.#context, workspaceId, this.#canvasId);
    const database = this.#context.database();
    withImmediateTransaction(database, () => {
      const insert = database.prepare(
        'INSERT INTO events (canvas_id, event_json) VALUES (?, ?)',
      );
      for (const record of records) {
        insert.run(this.#canvasId, record);
      }
    });
  }

  async readChanges(threadIdInput: string): Promise<CanvasChangeRecord[]> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    this.#workspace();
    const row = this.#context
      .database()
      .prepare(
        `SELECT snapshot_json
         FROM changes
         WHERE canvas_id = ? AND thread_id = ?`,
      )
      .get(this.#canvasId, threadId);
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
    requireSpace(this.#context, this.#workspace(), this.#canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () =>
      appendSqliteChangesInTransaction(
        database,
        this.#canvasId,
        threadId,
        records,
      ),
    );
  }

  async deleteChange(
    threadIdInput: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    requireSpace(this.#context, this.#workspace(), this.#canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      const current = database
        .prepare(
          `SELECT snapshot_json
           FROM changes
           WHERE canvas_id = ? AND thread_id = ?`,
        )
        .get(this.#canvasId, threadId);
      if (current === undefined) return null;
      const existing = decodeChanges(
        current['snapshot_json'],
        this.#canvasId,
        threadId,
      );
      const index = existing.findIndex((record) => record.id === changeId);
      if (index < 0) return null;
      const [removed] = existing.splice(index, 1);
      database
        .prepare(
          `UPDATE changes
           SET snapshot_json = ?
           WHERE canvas_id = ? AND thread_id = ?`,
        )
        .run(
          stringifyJson(existing, `Changes for thread ${threadId}`),
          this.#canvasId,
          threadId,
        );
      return removed ?? null;
    });
  }
}

export function createSqliteSpaceLogs(
  context: SqliteStoreContext,
  workspaceId: string,
  canvasId: string,
): SqliteSpaceLogs {
  const coordinator = new SqliteSpaceLogCoordinator(
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
