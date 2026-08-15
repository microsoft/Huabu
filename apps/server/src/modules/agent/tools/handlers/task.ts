// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { runCompletionService } from '../../../task/run-completion.service.js';
import { runLauncher } from '../../../task/run-launcher.js';
import { taskService } from '../../../task/task.service.js';

import type {
  CompleteTaskRunToolParams,
  CreateTaskRequest,
  StartTaskRunToolParams,
} from '@huabu/shared';

export type CreateTaskArgs = CreateTaskRequest & { canvasId: string };
export type StartTaskRunArgs = StartTaskRunToolParams & { canvasId: string };
export type CompleteTaskRunArgs = CompleteTaskRunToolParams & {
  canvasId: string;
};

export async function handleCreateTask(args: CreateTaskArgs): Promise<string> {
  const task = await taskService.create(args.canvasId, {
    goal: args.goal,
    defaultRootProfileId: args.defaultRootProfileId,
    position: args.position,
  });
  return JSON.stringify({ task });
}

export async function handleStartTaskRun(
  args: StartTaskRunArgs,
): Promise<string> {
  const run = await runLauncher.start(args.canvasId, args.taskId, {
    ...(args.rootProfileId !== undefined
      ? { rootProfileId: args.rootProfileId }
      : {}),
    ...(args.workingDirPath !== undefined
      ? { workingDirPath: args.workingDirPath }
      : {}),
    ...(args.additionalInitialPreamble !== undefined
      ? { additionalInitialPreamble: args.additionalInitialPreamble }
      : {}),
  });
  return JSON.stringify({ run });
}

export async function handleCompleteTaskRun(
  args: CompleteTaskRunArgs,
): Promise<string> {
  const run = await runCompletionService.complete(
    args.canvasId,
    args.taskId,
    args.runId,
    args.message !== undefined ? { message: args.message } : {},
  );
  return JSON.stringify({ run });
}
