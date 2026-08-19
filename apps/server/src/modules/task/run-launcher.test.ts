// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { RunLaunchError, RunLauncher } from './run-launcher.js';
import { AgentNodeCreationError } from '../agent/agent-node.service.js';
import { SelectableAgentProfileError } from '../agent/selectable-agent-profile.js';

import type { AgentThreadInvocation } from '../agent/agent-thread.service.js';
import type { SpaceTasks } from '../storage/index.js';
import type { AgentStreamEvent, TaskRunRecord } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const TASK = {
  taskId: 'task-a',
  canvasId: 'canvas-a',
  goal: 'Investigate the issue',
  defaultRootProfileId: 'profile-default',
  anchorNodeId: 'node-task',
  createdAt: 1,
};

const logger = {
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

async function* noEvents(): AsyncGenerator<AgentStreamEvent, void> {
  yield* [];
}

function createHarness(options?: {
  profileError?: SelectableAgentProfileError;
  positionError?: Error;
  createError?: Error;
  invokeError?: Error;
  runningUpdateError?: Error;
}) {
  const calls: string[] = [];
  const runs: TaskRunRecord[] = [];
  const createRun = vi.fn(async (run: TaskRunRecord) => {
    calls.push('insert-run');
    runs.push(run);
  });
  const updateRun = vi.fn(
    async (
      runId: string,
      update: Partial<TaskRunRecord>,
    ): Promise<TaskRunRecord> => {
      if (update.status === 'running' && options?.runningUpdateError) {
        calls.push('running-update');
        throw options.runningUpdateError;
      }
      calls.push(
        update.status === 'running' ? 'running-update' : 'root-update',
      );
      const index = runs.findIndex((run) => run.runId === runId);
      const updated = { ...runs[index], ...update } as TaskRunRecord;
      runs[index] = updated;
      return updated;
    },
  );
  const repository = {
    read: vi.fn(async () => ({ version: 1 as const, tasks: [TASK], runs })),
    create: vi.fn(),
    runs: {
      create: createRun,
      update: updateRun,
      complete: vi.fn(),
    },
  } as SpaceTasks;
  const dispose = vi.fn().mockResolvedValue(undefined);
  const invocation: AgentThreadInvocation = {
    binding: {
      kind: 'external',
      profileId: 'profile-override',
      alias: 'Agent',
    },
    fixedTarget: null,
    signal: new AbortController().signal,
    events: noEvents(),
    dispose,
  };
  const createAgentNode = options?.createError
    ? vi.fn(async () => {
        calls.push('create-agent');
        throw options.createError;
      })
    : vi.fn(async () => {
        calls.push('create-agent');
        return {
          canvasId: 'canvas-a',
          nodeId: 'node-root' as const,
          threadId: 'thread-root',
          profileId: 'profile-a',
          parentConnection: 'connected' as const,
        };
      });
  const invokeAgent = options?.invokeError
    ? vi.fn(async () => {
        calls.push('invoke-agent');
        throw options.invokeError;
      })
    : vi.fn(async () => {
        calls.push('invoke-agent');
        return invocation;
      });
  const drainInvocation = vi.fn(async () => {
    calls.push('drain');
  });
  const times = [100, 200];
  const service = new RunLauncher({
    repository: () => repository,
    requireProfile: vi.fn(() => {
      if (options?.profileError) throw options.profileError;
    }),
    resolveRootPosition: vi.fn(async () => {
      calls.push('resolve-position');
      if (options?.positionError) throw options.positionError;
      return { x: 420, y: 20 };
    }),
    createAgentNode,
    invokeAgent,
    drainInvocation,
    now: () => times.shift() ?? 300,
    logger,
  });
  return {
    service,
    repository,
    runs,
    calls,
    createAgentNode,
    invokeAgent,
    drainInvocation,
    dispose,
  };
}

describe('RunLauncher', () => {
  it('persists pending, creates the root Agent, marks running, then drains', async () => {
    const harness = createHarness();

    const run = await harness.service.start('canvas-a', 'task-a', {
      rootProfileId: 'profile-override',
      workingDirPath: '/work/task',
      additionalInitialPreamble: 'Focus on the issue.',
    });

    expect(run).toEqual({
      runId: expect.stringMatching(/^run-/),
      taskId: 'task-a',
      canvasIdSnapshot: 'canvas-a',
      goalSnapshot: 'Investigate the issue',
      rootProfileIdSnapshot: 'profile-override',
      status: 'running',
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
      createdAt: 100,
      startedAt: 200,
    });
    expect(harness.createAgentNode).toHaveBeenCalledWith({
      canvasId: 'canvas-a',
      profileId: 'profile-override',
      position: { x: 420, y: 20 },
      anchor: { kind: 'task-root', taskNoteNodeId: 'node-task' },
      launchOverrides: {
        workingDirPath: '/work/task',
        additionalInitialPreamble: 'Focus on the issue.',
      },
    });
    expect(harness.invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-root',
        canvasId: 'canvas-a',
        content: 'Investigate the issue',
        mode: 'operate',
      }),
    );
    expect(harness.calls).toEqual([
      'insert-run',
      'resolve-position',
      'create-agent',
      'root-update',
      'invoke-agent',
      'running-update',
      'drain',
    ]);
  });

  it('rejects missing Tasks and unavailable Profiles before persisting a Run', async () => {
    const missing = createHarness();
    missing.repository.read = vi.fn(async () => ({
      version: 1 as const,
      tasks: [],
      runs: [],
    }));
    await expect(
      missing.service.start('canvas-a', 'task-missing', {}),
    ).rejects.toMatchObject({ code: 'task_not_found' });
    expect(missing.repository.runs.create).not.toHaveBeenCalled();

    const unavailable = createHarness({
      profileError: new SelectableAgentProfileError(
        'profile_not_selectable',
        'not selectable',
      ),
    });
    await expect(
      unavailable.service.start('canvas-a', 'task-a', {}),
    ).rejects.toMatchObject({ code: 'profile_not_found' });
    expect(unavailable.repository.runs.create).not.toHaveBeenCalled();
  });

  it('retains partial root identity when lineage creation fails', async () => {
    const harness = createHarness({
      createError: new AgentNodeCreationError(
        'lineage_edge_failed',
        'edge rejected',
        'node-partial',
        'thread-partial',
      ),
    });

    await expect(
      harness.service.start('canvas-a', 'task-a', {}),
    ).rejects.toMatchObject({
      code: 'root_node_creation_failed',
      rootNodeId: 'node-partial',
      rootThreadId: 'thread-partial',
    });
    expect(harness.runs[0]).toMatchObject({
      status: 'pending',
      rootNodeId: 'node-partial',
      rootThreadId: 'thread-partial',
    });
    expect(harness.invokeAgent).not.toHaveBeenCalled();
  });

  it('leaves an inspectable pending Run when positioning or invocation fails', async () => {
    const position = createHarness({
      positionError: new Error('anchor missing'),
    });
    await expect(
      position.service.start('canvas-a', 'task-a', {}),
    ).rejects.toMatchObject({ code: 'root_position_failed' });
    expect(position.runs[0]).toMatchObject({ status: 'pending' });
    expect(position.createAgentNode).not.toHaveBeenCalled();

    const invocation = createHarness({
      invokeError: new Error('lifecycle rejected'),
    });
    await expect(
      invocation.service.start('canvas-a', 'task-a', {}),
    ).rejects.toMatchObject({
      code: 'invocation_failed',
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
    });
    expect(invocation.runs[0]).toMatchObject({
      status: 'pending',
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
    });
    expect(invocation.drainInvocation).not.toHaveBeenCalled();
  });

  it('disposes a prepared invocation when running persistence fails', async () => {
    const persistenceError = new Error('disk full');
    const harness = createHarness({ runningUpdateError: persistenceError });

    let error: unknown;
    try {
      await harness.service.start('canvas-a', 'task-a', {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RunLaunchError);
    expect(error).toMatchObject({
      code: 'running_persistence_failed',
      runId: expect.stringMatching(/^run-/),
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
    });
    expect(harness.dispose).toHaveBeenCalledWith(persistenceError);
    expect(harness.drainInvocation).not.toHaveBeenCalled();
    expect(harness.runs[0]).toMatchObject({
      status: 'pending',
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
    });
  });
});
