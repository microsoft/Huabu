// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  startTaskRunRequestSchema,
  type AgentLaunchOverrides,
  type CanvasNodeId,
  type Point,
  type StartTaskRunRequest,
  type TaskRecord,
  type TaskRunRecord,
} from '@huabu/shared';

import { getLogger } from '../../utils/logger.js';
import {
  InvalidAgentLaunchOverridesError,
  parseAgentLaunchOverrides,
} from '../agent/agent-launch-overrides.js';
import {
  AgentNodeCreationError,
  agentNodeService,
  type CreateAgentNodeInput,
  type CreateAgentNodeResult,
} from '../agent/agent-node.service.js';
import {
  type AgentThreadInvocation,
  type AgentThreadInvocationOptions,
  agentThreadService,
} from '../agent/agent-thread.service.js';
import {
  requireAvailableAgentProfile,
  SelectableAgentProfileError,
} from '../agent/selectable-agent-profile.js';
import { buildSpatialBundle } from '../canvas/canvas-spatial.js';
import { getStructuredStore, space } from '../storage/index.js';

import type { ChatEnvelope } from '../agent/conversation/envelope.js';
import type { SpaceTasks } from '../storage/index.js';
import type { FastifyBaseLogger } from 'fastify';

const ROOT_AGENT_HORIZONTAL_GAP = 120;
const ROOT_AGENT_VERTICAL_STEP = 180;

function createRootEnvelope(goal: string): ChatEnvelope {
  return {
    user: { text: goal, attachments: [] },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      selection: {
        refs: [],
        selectedIds: [],
        imageAttachments: [],
        snapshotAttachments: [],
      },
    },
  };
}

export async function resolveRootAgentPosition(
  canvasId: string,
  anchorNodeId: string,
  runOrdinal: number,
): Promise<Point> {
  const canvas = await space(canvasId).read();
  if (!canvas) throw new Error(`Canvas ${canvasId} does not exist`);
  const bundle = buildSpatialBundle(canvas);
  const anchor = bundle.spatialById.get(anchorNodeId);
  const rawAnchor = bundle.rawById.get(anchorNodeId);
  if (!anchor || rawAnchor?.type !== 'note') {
    throw new Error(`Task Note ${anchorNodeId} does not exist`);
  }
  return {
    x: anchor.rect.x + anchor.rect.width + ROOT_AGENT_HORIZONTAL_GAP,
    y: anchor.rect.y + runOrdinal * ROOT_AGENT_VERTICAL_STEP,
  };
}

async function drainInvocation(
  invocation: AgentThreadInvocation,
): Promise<void> {
  for await (const _event of invocation.events) {
    // Agenetes and AgentThreadService own event persistence and lifecycle.
  }
}

interface RunLauncherDependencies {
  repository: (canvasId: string) => SpaceTasks;
  requireProfile: (profileId: string) => void;
  resolveRootPosition: (
    canvasId: string,
    anchorNodeId: string,
    runOrdinal: number,
  ) => Promise<Point>;
  createAgentNode: (
    input: CreateAgentNodeInput,
  ) => Promise<CreateAgentNodeResult>;
  invokeAgent: (
    options: AgentThreadInvocationOptions,
  ) => Promise<AgentThreadInvocation>;
  drainInvocation: (invocation: AgentThreadInvocation) => Promise<void>;
  now: () => number;
  logger: FastifyBaseLogger;
}

const DEFAULT_DEPENDENCIES: RunLauncherDependencies = {
  repository: (canvasId) => getStructuredStore().space(canvasId).tasks,
  requireProfile: (profileId) => {
    requireAvailableAgentProfile(profileId);
  },
  resolveRootPosition: resolveRootAgentPosition,
  createAgentNode: (input) => agentNodeService.create(input),
  invokeAgent: (options) => agentThreadService.invoke(options),
  drainInvocation,
  now: Date.now,
  logger: getLogger('run-launcher'),
};

export type RunLaunchErrorCode =
  | 'invalid_input'
  | 'task_not_found'
  | 'profile_registry_unavailable'
  | 'profile_not_found'
  | 'run_persistence_failed'
  | 'root_position_failed'
  | 'root_node_creation_failed'
  | 'root_binding_persistence_failed'
  | 'invocation_failed'
  | 'running_persistence_failed';

export class RunLaunchError extends Error {
  readonly cause?: unknown;

  constructor(
    public readonly code: RunLaunchErrorCode,
    message: string,
    public readonly runId?: string,
    public readonly rootNodeId?: CanvasNodeId,
    public readonly rootThreadId?: string,
    cause?: unknown,
    public readonly cleanupError?: unknown,
  ) {
    super(message);
    this.name = 'RunLaunchError';
    this.cause = cause;
  }
}

export interface RunLaunchContext {
  logger?: FastifyBaseLogger;
}

function reason(error: unknown): string {
  return error instanceof Error ? `: ${error.message}` : '';
}

export class RunLauncher {
  constructor(
    private readonly dependencies: RunLauncherDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async start(
    canvasId: string,
    taskId: string,
    input: StartTaskRunRequest,
    context: RunLaunchContext = {},
  ): Promise<TaskRunRecord> {
    const parsed = startTaskRunRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RunLaunchError(
        'invalid_input',
        parsed.error.issues[0]?.message ?? 'Invalid Run input',
      );
    }

    let launchOverrides: AgentLaunchOverrides | undefined;
    try {
      launchOverrides = parseAgentLaunchOverrides({
        workingDirPath: parsed.data.workingDirPath,
        additionalInitialPreamble: parsed.data.additionalInitialPreamble,
      });
    } catch (error) {
      if (error instanceof InvalidAgentLaunchOverridesError) {
        throw new RunLaunchError('invalid_input', error.message);
      }
      throw error;
    }

    const repository = this.dependencies.repository(canvasId);
    const task = (await repository.read()).tasks.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!task) {
      throw new RunLaunchError(
        'task_not_found',
        `Task ${taskId} does not exist in Canvas ${canvasId}`,
      );
    }

    const rootProfileId =
      parsed.data.rootProfileId ?? task.defaultRootProfileId;
    this.requireProfile(rootProfileId);

    const run: TaskRunRecord = {
      runId: createId('run'),
      taskId: task.taskId,
      canvasIdSnapshot: task.canvasId,
      goalSnapshot: task.goal,
      rootProfileIdSnapshot: rootProfileId,
      status: 'pending',
      createdAt: this.dependencies.now(),
    };
    try {
      await repository.runs.create(run);
    } catch (error) {
      throw new RunLaunchError(
        'run_persistence_failed',
        `Run ${run.runId} could not be persisted${reason(error)}`,
        run.runId,
        undefined,
        undefined,
        error,
      );
    }

    const position = await this.resolvePosition(repository, task, run.runId);
    const root = await this.createRootAgent(
      repository,
      task,
      run,
      rootProfileId,
      position,
      launchOverrides,
    );

    try {
      await repository.runs.update(run.runId, {
        rootNodeId: root.nodeId,
        rootThreadId: root.threadId,
      });
    } catch (error) {
      throw new RunLaunchError(
        'root_binding_persistence_failed',
        `Root Agent ${root.nodeId} was created but Run ${run.runId} could not record it${reason(error)}`,
        run.runId,
        root.nodeId,
        root.threadId,
        error,
      );
    }

    const logger = context.logger ?? this.dependencies.logger;
    let invocation: AgentThreadInvocation;
    try {
      invocation = await this.dependencies.invokeAgent({
        threadId: root.threadId,
        canvasId,
        content: run.goalSnapshot,
        mode: 'operate',
        envelope: createRootEnvelope(run.goalSnapshot),
        logger,
      });
    } catch (error) {
      throw new RunLaunchError(
        'invocation_failed',
        `Root Agent invocation for Run ${run.runId} could not start${reason(error)}`,
        run.runId,
        root.nodeId,
        root.threadId,
        error,
      );
    }

    let running: TaskRunRecord;
    try {
      running = await repository.runs.update(run.runId, {
        status: 'running',
        startedAt: this.dependencies.now(),
      });
    } catch (error) {
      let cleanupError: unknown;
      try {
        await invocation.dispose(error);
      } catch (caught) {
        cleanupError = caught;
      }
      throw new RunLaunchError(
        'running_persistence_failed',
        `Root Agent was prepared but Run ${run.runId} could not become running${reason(error)}`,
        run.runId,
        root.nodeId,
        root.threadId,
        error,
        cleanupError,
      );
    }

    void this.dependencies.drainInvocation(invocation).catch((error) => {
      logger.error(
        { err: error, runId: run.runId, threadId: root.threadId },
        'Root Task Run invocation failed while draining',
      );
    });
    return running;
  }

  private requireProfile(profileId: string): void {
    try {
      this.dependencies.requireProfile(profileId);
    } catch (error) {
      if (error instanceof SelectableAgentProfileError) {
        throw new RunLaunchError(
          error.code === 'registry_unavailable'
            ? 'profile_registry_unavailable'
            : 'profile_not_found',
          error.code === 'profile_not_selectable'
            ? `Agent Profile ${profileId} is unavailable`
            : error.message,
        );
      }
      throw error;
    }
  }

  private async resolvePosition(
    repository: SpaceTasks,
    task: TaskRecord,
    runId: string,
  ): Promise<Point> {
    try {
      const taskRuns = (await repository.read()).runs.filter(
        (candidate) => candidate.taskId === task.taskId,
      );
      const runOrdinal = taskRuns.findIndex(
        (candidate) => candidate.runId === runId,
      );
      if (runOrdinal < 0) {
        throw new Error(`Run ${runId} disappeared after creation`);
      }
      return await this.dependencies.resolveRootPosition(
        task.canvasId,
        task.anchorNodeId,
        runOrdinal,
      );
    } catch (error) {
      throw new RunLaunchError(
        'root_position_failed',
        `Run ${runId} could not resolve a root Agent position${reason(error)}`,
        runId,
        undefined,
        undefined,
        error,
      );
    }
  }

  private async createRootAgent(
    repository: SpaceTasks,
    task: TaskRecord,
    run: TaskRunRecord,
    rootProfileId: string,
    position: Point,
    launchOverrides: AgentLaunchOverrides | undefined,
  ): Promise<CreateAgentNodeResult> {
    try {
      return await this.dependencies.createAgentNode({
        canvasId: task.canvasId,
        profileId: rootProfileId,
        position,
        anchor: {
          kind: 'task-root',
          taskNoteNodeId: task.anchorNodeId as CanvasNodeId,
        },
        ...(launchOverrides ? { launchOverrides } : {}),
      });
    } catch (error) {
      const partial =
        error instanceof AgentNodeCreationError && error.createdNodeId
          ? {
              nodeId: error.createdNodeId,
              threadId: error.createdThreadId,
            }
          : undefined;
      let cleanupError: unknown;
      if (partial) {
        try {
          await repository.runs.update(run.runId, {
            rootNodeId: partial.nodeId,
            ...(partial.threadId ? { rootThreadId: partial.threadId } : {}),
          });
        } catch (caught) {
          cleanupError = caught;
        }
      }
      throw new RunLaunchError(
        'root_node_creation_failed',
        `Run ${run.runId} could not create its root Agent${reason(error)}`,
        run.runId,
        partial?.nodeId,
        partial?.threadId,
        error,
        cleanupError,
      );
    }
  }
}

export const runLauncher = new RunLauncher();
