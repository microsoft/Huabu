// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  createTaskRequestSchema,
  type CanvasCommand,
  type CanvasNodeId,
  type CreateTaskRequest,
  type TaskRecord,
} from '@huabu/shared';

import {
  requireAvailableAgentProfile,
  SelectableAgentProfileError,
} from '../agent/selectable-agent-profile.js';
import { executeCanvasCommandsOnHost } from '../canvas/canvas-command-router.js';
import { getStructuredStore } from '../storage/index.js';

import type { ExecuteOnServerOutput } from '../canvas/canvas-executor.js';
import type { SpaceTasks } from '../storage/index.js';

interface TaskServiceDependencies {
  canvasExists: (canvasId: string) => Promise<boolean>;
  requireProfile: (profileId: string) => void;
  repository: (canvasId: string) => SpaceTasks;
  execute: (input: {
    canvasId: string;
    commands: readonly CanvasCommand[];
    originator: { source: 'system' };
  }) => Promise<ExecuteOnServerOutput>;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: TaskServiceDependencies = {
  canvasExists: async (canvasId) =>
    (await getStructuredStore().space(canvasId).read()) !== null,
  requireProfile: (profileId) => {
    requireAvailableAgentProfile(profileId);
  },
  repository: (canvasId) => getStructuredStore().space(canvasId).tasks,
  execute: executeCanvasCommandsOnHost,
  now: Date.now,
};

export type TaskCreationErrorCode =
  | 'invalid_input'
  | 'canvas_not_found'
  | 'profile_registry_unavailable'
  | 'profile_not_found'
  | 'note_creation_failed'
  | 'task_persistence_failed';

export class TaskCreationError extends Error {
  constructor(
    public readonly code: TaskCreationErrorCode,
    message: string,
    public readonly createdAnchorNodeId?: CanvasNodeId,
  ) {
    super(message);
    this.name = 'TaskCreationError';
  }
}

export class TaskService {
  constructor(
    private readonly dependencies: TaskServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async create(
    canvasId: string,
    input: CreateTaskRequest,
  ): Promise<TaskRecord> {
    const parsed = createTaskRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new TaskCreationError(
        'invalid_input',
        parsed.error.issues[0]?.message ?? 'Invalid Task input',
      );
    }
    if (!(await this.dependencies.canvasExists(canvasId))) {
      throw new TaskCreationError(
        'canvas_not_found',
        `Canvas ${canvasId} does not exist`,
      );
    }
    try {
      this.dependencies.requireProfile(parsed.data.defaultRootProfileId);
    } catch (error) {
      if (error instanceof SelectableAgentProfileError) {
        throw new TaskCreationError(
          error.code === 'registry_unavailable'
            ? 'profile_registry_unavailable'
            : 'profile_not_found',
          error.code === 'profile_not_selectable'
            ? `Agent Profile ${parsed.data.defaultRootProfileId} is unavailable`
            : error.message,
        );
      }
      throw error;
    }

    const taskId = createId('task');
    const anchorNodeId = createId('node') as CanvasNodeId;
    const output = await this.dependencies.execute({
      canvasId,
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: anchorNodeId,
              nodeType: 'note',
              position: parsed.data.position,
              data: {
                label: 'Task',
                content: parsed.data.goal,
                origin: { type: 'ai-operate' },
              },
            },
          ],
        },
      ],
      originator: { source: 'system' },
    });
    if (output.results[0]?.applied !== true) {
      throw new TaskCreationError(
        'note_creation_failed',
        'Task Note creation was rejected',
      );
    }

    const task: TaskRecord = {
      taskId,
      canvasId,
      goal: parsed.data.goal,
      defaultRootProfileId: parsed.data.defaultRootProfileId,
      anchorNodeId,
      createdAt: this.dependencies.now(),
    };
    try {
      await this.dependencies.repository(canvasId).create(task);
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : '';
      throw new TaskCreationError(
        'task_persistence_failed',
        `Task Note was created but its Task record could not be persisted${reason}`,
        anchorNodeId,
      );
    }
    return task;
  }
}

export const taskService = new TaskService();
