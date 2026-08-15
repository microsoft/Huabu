// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  RunCompletionError,
  RunCompletionService,
} from './run-completion.service.js';

import type { TaskRunCompletionResult } from '../storage/index.js';
import type { SpaceTasks } from '../storage/index.js';

const completedRun = {
  runId: 'run-a',
  taskId: 'task-a',
  canvasIdSnapshot: 'canvas-a',
  goalSnapshot: 'Investigate',
  rootProfileIdSnapshot: 'profile-a',
  status: 'completed' as const,
  createdAt: 1,
  startedAt: 2,
  completion: { completedAt: 3, message: 'PR merged' },
};

function createHarness(result: TaskRunCompletionResult) {
  const complete = vi.fn().mockResolvedValue(result);
  const repository = {
    runs: { complete },
  } as unknown as SpaceTasks;
  const service = new RunCompletionService({
    repository: () => repository,
    now: () => 3,
  });
  return { service, complete };
}

describe('RunCompletionService', () => {
  it('completes and normalizes one running Run', async () => {
    const { service, complete } = createHarness({
      outcome: 'completed',
      run: completedRun,
    });

    await expect(
      service.complete('canvas-a', 'task-a', 'run-a', {
        message: '  PR merged  ',
      }),
    ).resolves.toEqual(completedRun);
    expect(complete).toHaveBeenCalledWith('task-a', 'run-a', {
      completedAt: 3,
      message: 'PR merged',
    });
  });

  it('returns an idempotent completion and maps domain conflicts', async () => {
    const unchanged = createHarness({
      outcome: 'unchanged',
      run: completedRun,
    });
    await expect(
      unchanged.service.complete('canvas-a', 'task-a', 'run-a', {
        message: 'PR merged',
      }),
    ).resolves.toEqual(completedRun);

    const conflict = createHarness({
      outcome: 'completion_conflict',
      run: completedRun,
    });
    await expect(
      conflict.service.complete('canvas-a', 'task-a', 'run-a', {
        message: 'Different',
      }),
    ).rejects.toMatchObject({ code: 'completion_conflict' });
  });

  it.each([
    ['task_not_found', 'task_not_found'],
    ['run_not_found', 'run_not_found'],
  ] as const)('maps %s results', async (outcome, code) => {
    const { service } = createHarness({ outcome });
    await expect(
      service.complete('canvas-a', 'task-a', 'run-a', {}),
    ).rejects.toMatchObject({ code });
  });

  it('rejects pending Runs and persistence failures explicitly', async () => {
    const pending = {
      ...completedRun,
      status: 'pending' as const,
      completion: undefined,
    };
    const notRunning = createHarness({
      outcome: 'run_not_running',
      run: pending,
    });
    await expect(
      notRunning.service.complete('canvas-a', 'task-a', 'run-a', {}),
    ).rejects.toMatchObject({ code: 'run_not_running' });

    const repository = {
      runs: { complete: vi.fn().mockRejectedValue(new Error('disk full')) },
    } as unknown as SpaceTasks;
    const service = new RunCompletionService({
      repository: () => repository,
      now: () => 3,
    });
    await expect(
      service.complete('canvas-a', 'task-a', 'run-a', {}),
    ).rejects.toBeInstanceOf(RunCompletionError);
    await expect(
      service.complete('canvas-a', 'task-a', 'run-a', {}),
    ).rejects.toMatchObject({ code: 'completion_persistence_failed' });
  });
});
