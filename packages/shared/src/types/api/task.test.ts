// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { completeTaskRunRequestSchema, taskRunRecordSchema } from './task.js';

const runningRun = {
  runId: 'run-a',
  taskId: 'task-a',
  canvasIdSnapshot: 'canvas-a',
  goalSnapshot: 'Investigate',
  rootProfileIdSnapshot: 'profile-a',
  status: 'running' as const,
  createdAt: 1,
  startedAt: 2,
};

describe('Task Run completion contracts', () => {
  it('requires completion metadata exactly for completed Runs', () => {
    expect(
      taskRunRecordSchema.safeParse({
        ...runningRun,
        status: 'completed',
      }).success,
    ).toBe(false);
    expect(
      taskRunRecordSchema.safeParse({
        ...runningRun,
        completion: { completedAt: 3 },
      }).success,
    ).toBe(false);
    expect(
      taskRunRecordSchema.safeParse({
        ...runningRun,
        status: 'completed',
        completion: { completedAt: 3, message: 'PR merged' },
      }).success,
    ).toBe(true);
  });

  it('normalizes and bounds the optional completion message', () => {
    expect(
      completeTaskRunRequestSchema.parse({ message: '  PR merged  ' }),
    ).toEqual({ message: 'PR merged' });
    expect(
      completeTaskRunRequestSchema.safeParse({ message: '' }).success,
    ).toBe(false);
    expect(
      completeTaskRunRequestSchema.safeParse({
        message: 'x'.repeat(4_097),
      }).success,
    ).toBe(false);
  });
});
