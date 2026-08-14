// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasEventInputSchema, canvasEventRecordSchema } from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { withImmediateTransaction } from './database.js';
import { parseJson, stringifyJson } from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteStoreContext } from './database.js';
import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type {
  NewCanvasEvent,
  SpaceChanges,
  SpaceEvents,
} from '../../ports/structured.js';
import type { z } from 'zod';

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown schema violation';
  const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${location}: ${issue.message}`;
}

function requireSpace(context: SqliteStoreContext, canvasId: string): void {
  context.assertMutationAllowed(canvasId);
  if (
    context
      .database()
      .prepare('SELECT 1 AS present FROM spaces WHERE canvas_id = ?')
      .get(canvasId)?.['present'] !== 1
  ) {
    throw new Error(
      `SQLite Space logs(${canvasId}) cannot mutate a missing Space`,
    );
  }
}

function decodeEvents(rows: readonly Record<string, unknown>[]): CanvasEvent[] {
  return rows.map((row, index) => {
    const parsedJson = parseJson(
      row['event_json'],
      `Canvas event ${index + 1}`,
    );
    const parsed = canvasEventRecordSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new SyntaxError(
        `Invalid persisted Canvas event ${index + 1}: ${firstIssue(parsed.error)}`,
      );
    }
    return parsedJson as CanvasEvent;
  });
}

function decodeChanges(
  value: unknown,
  canvasId: string,
  threadId: string,
): CanvasChangeRecord[] {
  const parsed = parseJson(
    value,
    `changes for Space ${JSON.stringify(canvasId)} thread ${JSON.stringify(threadId)}`,
  );
  if (!Array.isArray(parsed)) {
    throw new SyntaxError(
      `Persisted changes for Space ${canvasId} thread ${threadId} must be an array`,
    );
  }
  return coalesceChanges(parsed as CanvasChangeRecord[]);
}

export interface SqliteSpaceLogs {
  readonly events: SpaceEvents;
  readonly changes: SpaceChanges;
}

class SqliteSpaceLogCoordinator {
  readonly #context: SqliteStoreContext;
  readonly #canvasId: string;

  constructor(context: SqliteStoreContext, canvasId: string) {
    this.#context = context;
    this.#canvasId = canvasId;
  }

  async readEvents(limit?: number): Promise<CanvasEvent[]> {
    const database = this.#context.database();
    if (limit !== undefined && !(limit > 0)) return [];
    if (limit === undefined || !Number.isFinite(limit)) {
      return decodeEvents(
        database
          .prepare(
            `SELECT event_json
             FROM events
             WHERE canvas_id = ?
             ORDER BY event_id ASC`,
          )
          .all(this.#canvasId),
      );
    }
    const rows = database
      .prepare(
        `SELECT event_json
         FROM events
         WHERE canvas_id = ?
         ORDER BY event_id DESC
         LIMIT ?`,
      )
      .all(this.#canvasId, Math.ceil(limit))
      .reverse();
    return decodeEvents(rows);
  }

  async appendEvents(events: readonly NewCanvasEvent[]): Promise<void> {
    this.#context.assertOpen();
    if (events.length === 0) return;
    const records: CanvasEvent[] = events.map((event, index) => {
      const input = canvasEventInputSchema.safeParse(event);
      if (!input.success) {
        throw new TypeError(
          `Invalid Canvas event append input at index ${index}: ${firstIssue(input.error)}`,
        );
      }
      const record = {
        payload: event.payload,
        ts: event.ts ?? this.#context.now(),
      };
      const parsed = canvasEventRecordSchema.safeParse(record);
      if (!parsed.success) {
        throw new TypeError(
          `Invalid Canvas event append record at index ${index}: ${firstIssue(parsed.error)}`,
        );
      }
      stringifyJson(record, `Canvas event append input ${index}`);
      return record;
    });

    requireSpace(this.#context, this.#canvasId);
    const database = this.#context.database();
    withImmediateTransaction(database, () => {
      const insert = database.prepare(
        'INSERT INTO events (canvas_id, event_json) VALUES (?, ?)',
      );
      for (const record of records) {
        insert.run(
          this.#canvasId,
          stringifyJson(record, `Canvas event for ${this.#canvasId}`),
        );
      }
    });
  }

  async readChanges(threadIdInput: string): Promise<CanvasChangeRecord[]> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
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
    requireSpace(this.#context, this.#canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      const current = database
        .prepare(
          `SELECT snapshot_json
           FROM changes
           WHERE canvas_id = ? AND thread_id = ?`,
        )
        .get(this.#canvasId, threadId);
      const existing =
        current === undefined
          ? []
          : decodeChanges(current['snapshot_json'], this.#canvasId, threadId);
      const merged = coalesceChanges([...existing, ...records]);
      database
        .prepare(
          `INSERT INTO changes (canvas_id, thread_id, snapshot_json)
           VALUES (?, ?, ?)
           ON CONFLICT(canvas_id, thread_id) DO UPDATE SET
             snapshot_json = excluded.snapshot_json`,
        )
        .run(
          this.#canvasId,
          threadId,
          stringifyJson(merged, `Changes for thread ${threadId}`),
        );
      return merged;
    });
  }

  async deleteChange(
    threadIdInput: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    const threadId = sanitizeId(threadIdInput, 'threadId');
    requireSpace(this.#context, this.#canvasId);
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
  canvasId: string,
): SqliteSpaceLogs {
  const coordinator = new SqliteSpaceLogCoordinator(context, canvasId);
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
