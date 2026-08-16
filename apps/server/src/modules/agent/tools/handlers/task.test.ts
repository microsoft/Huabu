// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCreateTask } from './task.js';
import { runCompletionService } from '../../../task/run-completion.service.js';
import { runLauncher } from '../../../task/run-launcher.js';
import { taskService } from '../../../task/task.service.js';
import { executeTool } from '../executor.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Task tool handlers', () => {
  it('delegates Task creation to TaskService', async () => {
    const task = {
      taskId: 'task-a',
      canvasId: 'canvas-a',
      goal: 'Investigate',
      defaultRootProfileId: 'profile-a',
      anchorNodeId: 'node-task',
      createdAt: 1,
    };
    const create = vi.spyOn(taskService, 'create').mockResolvedValue(task);

    await expect(
      handleCreateTask({
        canvasId: 'canvas-a',
        goal: 'Investigate',
        defaultRootProfileId: 'profile-a',
        position: { x: 10, y: 20 },
      }),
    ).resolves.toBe(JSON.stringify({ task }));
    expect(create).toHaveBeenCalledWith('canvas-a', {
      goal: 'Investigate',
      defaultRootProfileId: 'profile-a',
      position: { x: 10, y: 20 },
    });
  });

  it('delegates Run creation to RunLauncher', async () => {
    const run = {
      runId: 'run-a',
      taskId: 'task-a',
      canvasIdSnapshot: 'canvas-a',
      goalSnapshot: 'Investigate',
      rootProfileIdSnapshot: 'profile-b',
      status: 'running' as const,
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
      createdAt: 1,
      startedAt: 2,
    };
    const start = vi.spyOn(runLauncher, 'start').mockResolvedValue(run);

    await expect(
      executeTool(
        'start_task_run',
        {
          taskId: 'task-a',
          rootProfileId: 'profile-b',
          workingDirPath: '/work/task',
        },
        { canvasId: 'canvas-a' },
      ),
    ).resolves.toBe(JSON.stringify({ run }));
    expect(start).toHaveBeenCalledWith('canvas-a', 'task-a', {
      rootProfileId: 'profile-b',
      workingDirPath: '/work/task',
    });
  });

  it('injects Canvas scope through the tool executor', async () => {
    const task = {
      taskId: 'task-a',
      canvasId: 'canvas-a',
      goal: 'Investigate',
      defaultRootProfileId: 'profile-a',
      anchorNodeId: 'node-task',
      createdAt: 1,
    };
    const create = vi.spyOn(taskService, 'create').mockResolvedValue(task);

    await expect(
      executeTool(
        'create_task',
        {
          goal: 'Investigate',
          defaultRootProfileId: 'profile-a',
          position: { x: 10, y: 20 },
        },
        { canvasId: 'canvas-a' },
      ),
    ).resolves.toBe(JSON.stringify({ task }));
    expect(create).toHaveBeenCalledWith(
      'canvas-a',
      expect.objectContaining({ goal: 'Investigate' }),
    );
  });

  it('delegates explicit Run completion through the tool executor', async () => {
    const run = {
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
    const complete = vi
      .spyOn(runCompletionService, 'complete')
      .mockResolvedValue(run);

    await expect(
      executeTool(
        'complete_task_run',
        { taskId: 'task-a', runId: 'run-a', message: 'PR merged' },
        { canvasId: 'canvas-a' },
      ),
    ).resolves.toBe(JSON.stringify({ run }));
    expect(complete).toHaveBeenCalledWith('canvas-a', 'task-a', 'run-a', {
      message: 'PR merged',
    });
  });
});
