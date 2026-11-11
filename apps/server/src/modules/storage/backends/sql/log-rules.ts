// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasEventInputSchema, canvasEventRecordSchema } from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { parseJson, stringifyJson } from './codecs.js';

import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type { NewCanvasEvent } from '../../ports/structured.js';
import type { z } from 'zod';

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown schema violation';
  const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${location}: ${issue.message}`;
}

export function decodeEvents(
  rows: readonly Record<string, unknown>[],
  limit?: number,
): CanvasEvent[] {
  const records = rows.map((row, index) => {
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
  // Validate all history before applying a tail limit, including zero.
  if (limit === undefined) return records;
  if (!(limit > 0)) return [];
  return records.slice(-Math.ceil(limit));
}

export const SELECT_CHANGES = `
  SELECT snapshot_json
  FROM changes
  WHERE canvas_id = ? AND thread_id = ?`;

export const UPSERT_CHANGES = `
  INSERT INTO changes (canvas_id, thread_id, snapshot_json)
  VALUES (?, ?, ?)
  ON CONFLICT(canvas_id, thread_id) DO UPDATE SET
    snapshot_json = excluded.snapshot_json`;

/**
 * `records` folded into the thread's stored list (`row` is the
 * {@link SELECT_CHANGES} result, undefined when the thread holds none): the
 * coalesced list and the parameters of {@link UPSERT_CHANGES} that store it.
 */
export function mergeChangesRow(
  row: Record<string, unknown> | undefined,
  canvasId: string,
  threadId: string,
  records: readonly CanvasChangeRecord[],
): { merged: CanvasChangeRecord[]; params: [string, string, string] } {
  const existing =
    row === undefined
      ? []
      : decodeChanges(row['snapshot_json'], canvasId, threadId);
  const merged = coalesceChanges([...existing, ...records]);
  return {
    merged,
    params: [
      canvasId,
      threadId,
      stringifyJson(merged, `Changes for thread ${threadId}`),
    ],
  };
}

export function decodeChanges(
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

/** Validate and encode the entire batch before either backend starts writing. */
export function encodeEventBatch(
  events: readonly NewCanvasEvent[],
  now: () => number,
): string[] {
  return events.map((event, index) => {
    const input = canvasEventInputSchema.safeParse(event);
    if (!input.success) {
      throw new TypeError(
        `Invalid Canvas event append input at index ${index}: ${firstIssue(input.error)}`,
      );
    }
    const record = { payload: event.payload, ts: event.ts ?? now() };
    const parsed = canvasEventRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new TypeError(
        `Invalid Canvas event append record at index ${index}: ${firstIssue(parsed.error)}`,
      );
    }
    return stringifyJson(record, `Canvas event append input ${index}`);
  });
}
