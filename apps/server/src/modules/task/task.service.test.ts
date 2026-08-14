// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { TaskCreationError, TaskService } from './task.service.js';
import { SelectableAgentProfileError } from '../agent/selectable-agent-profile.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';
import type { SpaceTasks } from '../storage/index.js';

function output(applied = true): ExecuteOnServerOutput {
  return {
    canvasId: 'canvas-a',
    fromVersion: 1,
    toVersion: 2,
    deltas: [],
    commands: [],
    results: [
      {
        command: { type: 'DELETE_NODES', nodeIds: [] },
        applied,
      },
    ],
    pendingEffects: {
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  };
}

function createHarness(options?: {
  canvasExists?: boolean;
  profileError?: SelectableAgentProfileError;
  applied?: boolean;
  persistenceError?: Error;
}) {
  const createTask = options?.persistenceError
    ? vi.fn().mockRejectedValue(options.persistenceError)
    : vi.fn().mockResolvedValue(undefined);
  const repository = { create: createTask } as unknown as SpaceTasks;
  const execute = vi.fn().mockResolvedValue(output(options?.applied ?? true));
  const service = new TaskService({
    canvasExists: vi.fn().mockResolvedValue(options?.canvasExists ?? true),
    requireProfile: vi.fn(() => {
      if (options?.profileError) throw options.profileError;
    }),
    repository: () => repository,
    execute,
    now: () => 1234,
  });
  return { service, execute, createTask };
}

const INPUT = {
  goal: 'Investigate the issue',
  defaultRootProfileId: 'profile-a',
  position: { x: 100, y: 200 },
};

describe('TaskService', () => {
  it('creates one static Task Note before persisting its Task record', async () => {
    const { service, execute, createTask } = createHarness();

    const task = await service.create('canvas-a', INPUT);

    expect(task).toEqual({
      taskId: expect.stringMatching(/^task-/),
      canvasId: 'canvas-a',
      goal: 'Investigate the issue',
      defaultRootProfileId: 'profile-a',
      anchorNodeId: expect.stringMatching(/^node-/),
      createdAt: 1234,
    });
    expect(execute).toHaveBeenCalledWith({
      canvasId: 'canvas-a',
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: task.anchorNodeId,
              nodeType: 'note',
              position: { x: 100, y: 200 },
              data: {
                label: 'Task',
                content: 'Investigate the issue',
                origin: { type: 'ai-operate' },
              },
            },
          ],
        },
      ],
      originator: { source: 'system' },
    });
    expect(createTask).toHaveBeenCalledWith(task);
  });

  it('rejects missing Canvas and unavailable Profile before creating a Note', async () => {
    const missing = createHarness({ canvasExists: false });
    await expect(
      missing.service.create('canvas-a', INPUT),
    ).rejects.toMatchObject({ code: 'canvas_not_found' });
    expect(missing.execute).not.toHaveBeenCalled();

    const unavailable = createHarness({
      profileError: new SelectableAgentProfileError(
        'profile_not_selectable',
        'not selectable',
      ),
    });
    await expect(
      unavailable.service.create('canvas-a', INPUT),
    ).rejects.toMatchObject({ code: 'profile_not_found' });
    expect(unavailable.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid input before mutation and does not persist a rejected Note', async () => {
    const invalid = createHarness();
    await expect(
      invalid.service.create('canvas-a', { ...INPUT, goal: ' ' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(invalid.execute).not.toHaveBeenCalled();
    expect(invalid.createTask).not.toHaveBeenCalled();

    const rejected = createHarness({ applied: false });
    await expect(
      rejected.service.create('canvas-a', INPUT),
    ).rejects.toMatchObject({ code: 'note_creation_failed' });
    expect(rejected.createTask).not.toHaveBeenCalled();
  });

  it('reports the visible orphan Note when Task persistence fails', async () => {
    const { service } = createHarness({
      persistenceError: new Error('disk full'),
    });

    let error: unknown;
    try {
      await service.create('canvas-a', INPUT);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TaskCreationError);
    expect(error).toMatchObject({
      code: 'task_persistence_failed',
      createdAnchorNodeId: expect.stringMatching(/^node-/),
    });
  });
});
