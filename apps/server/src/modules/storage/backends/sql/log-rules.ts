// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasEventRecordSchema } from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { parseJson } from './codecs.js';

import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type { z } from 'zod';

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown schema violation';
  const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${location}: ${issue.message}`;
}

export function decodeEvents(
  rows: readonly Record<string, unknown>[],
): CanvasEvent[] {
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
