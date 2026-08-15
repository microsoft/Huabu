// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  completeTaskRunRequestSchema,
  type CompleteTaskRunRequest,
  type TaskRunRecord,
} from '@huabu/shared';

import { getStructuredStore } from '../storage/index.js';

import type { SpaceTasks } from '../storage/index.js';

interface RunCompletionServiceDependencies {
  repository: (canvasId: string) => SpaceTasks;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: RunCompletionServiceDependencies = {
  repository: (canvasId) => getStructuredStore().space(canvasId).tasks,
  now: Date.now,
};

export type RunCompletionErrorCode =
  | 'invalid_input'
  | 'task_not_found'
  | 'run_not_found'
  | 'run_not_running'
  | 'completion_conflict'
  | 'completion_persistence_failed';

export class RunCompletionError extends Error {
  readonly cause?: unknown;

  constructor(
    public readonly code: RunCompletionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'RunCompletionError';
    this.cause = cause;
  }
}

export class RunCompletionService {
  constructor(
    private readonly dependencies: RunCompletionServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async complete(
    canvasId: string,
    taskId: string,
    runId: string,
    input: CompleteTaskRunRequest,
  ): Promise<TaskRunRecord> {
    const parsed = completeTaskRunRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RunCompletionError(
        'invalid_input',
        parsed.error.issues[0]?.message ?? 'Invalid Run completion input',
      );
    }

    let result;
    try {
      result = await this.dependencies
        .repository(canvasId)
        .runs.complete(taskId, runId, {
          completedAt: this.dependencies.now(),
          ...(parsed.data.message !== undefined
            ? { message: parsed.data.message }
            : {}),
        });
    } catch (error) {
      throw new RunCompletionError(
        'completion_persistence_failed',
        `Run ${runId} could not be completed`,
        error,
      );
    }

    switch (result.outcome) {
      case 'completed':
      case 'unchanged':
        return result.run;
      case 'task_not_found':
        throw new RunCompletionError(
          'task_not_found',
          `Task ${taskId} does not exist in Canvas ${canvasId}`,
        );
      case 'run_not_found':
        throw new RunCompletionError(
          'run_not_found',
          `Run ${runId} does not exist for Task ${taskId}`,
        );
      case 'run_not_running':
        throw new RunCompletionError(
          'run_not_running',
          `Run ${runId} is ${result.run.status}; only running Runs can be completed`,
        );
      case 'completion_conflict':
        throw new RunCompletionError(
          'completion_conflict',
          `Run ${runId} is already completed with a different message`,
        );
    }
  }
}

export const runCompletionService = new RunCompletionService();
