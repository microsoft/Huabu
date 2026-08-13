// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable behavioral contract for {@link SpaceTasks} and its Runs. */

import { afterEach, describe, expect, it } from 'vitest';

import type {
  SpaceDeleteSession,
  SpaceTasks,
  TaskRunUpdate,
} from '../structured.js';
import type { TaskRecord, TaskRunRecord } from '@huabu/shared';

export interface SpaceTasksContractHarness {
  /** Task ledger for an existing Space, initially empty. */
  readonly tasks: SpaceTasks;
  /** A second retained handle for the same existing Space. */
  readonly concurrent: SpaceTasks;
  readonly canvasId: string;
  /** Task ledger scoped to a Space whose structural record is absent. */
  readonly missing: SpaceTasks;
  readonly missingCanvasId: string;
  /** Open a structured-deletion fence for `canvasId`. */
  readonly beginDelete: () => Promise<SpaceDeleteSession>;
  readonly cleanup?: () => Promise<void> | void;
}

function task(canvasId: string, taskId: string, createdAt: number): TaskRecord {
  return {
    taskId,
    canvasId,
    goal: `Goal for ${taskId}`,
    defaultRootProfileId: `profile-${taskId}`,
    anchorNodeId: `anchor-${taskId}`,
    createdAt,
  };
}

function run(
  canvasId: string,
  taskId: string,
  runId: string,
  createdAt: number,
): TaskRunRecord {
  return {
    runId,
    taskId,
    canvasIdSnapshot: canvasId,
    goalSnapshot: `Goal snapshot for ${taskId}`,
    rootProfileIdSnapshot: `profile-${taskId}`,
    status: 'pending',
    createdAt,
  };
}

export function describeSpaceTasksContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceTasksContractHarness>
    | SpaceTasksContractHarness,
): void {
  describe(`SpaceTasks contract: ${name}`, () => {
    let harness: SpaceTasksContractHarness | null = null;

    async function open(): Promise<SpaceTasksContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reads an empty versioned snapshot', async () => {
      const { tasks } = await open();

      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [],
        runs: [],
      });
    });

    it('creates a Task and rejects a duplicate id without replacing it', async () => {
      const { tasks, canvasId } = await open();
      const original = task(canvasId, 'task-duplicate', 1);
      await tasks.create(original);

      await expect(
        tasks.create({ ...original, goal: 'Replacement goal', createdAt: 2 }),
      ).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [original],
        runs: [],
      });
    });

    it('requires an existing Task before creating its Run', async () => {
      const { tasks, canvasId } = await open();
      const owner = task(canvasId, 'task-owner', 1);
      const ownedRun = run(canvasId, owner.taskId, 'run-owned', 2);

      await expect(tasks.runs.create(ownedRun)).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [],
        runs: [],
      });

      await tasks.create(owner);
      await tasks.runs.create(ownedRun);
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [owner],
        runs: [ownedRun],
      });
    });

    it('rejects a duplicate Run id without replacing it', async () => {
      const { tasks, canvasId } = await open();
      const owner = task(canvasId, 'task-run-duplicate', 1);
      const original = run(canvasId, owner.taskId, 'run-duplicate', 2);
      await tasks.create(owner);
      await tasks.runs.create(original);

      await expect(
        tasks.runs.create({
          ...original,
          status: 'running',
          startedAt: 3,
        }),
      ).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [owner],
        runs: [original],
      });
    });

    it('updates an existing Run and rejects a missing Run id', async () => {
      const { tasks, canvasId } = await open();
      const owner = task(canvasId, 'task-update', 1);
      const original = run(canvasId, owner.taskId, 'run-update', 2);
      await tasks.create(owner);
      await tasks.runs.create(original);
      const update: TaskRunUpdate = {
        rootNodeId: 'root-node',
        rootThreadId: 'root-thread',
        status: 'running',
        startedAt: 3,
      };

      await expect(tasks.runs.update(original.runId, update)).resolves.toEqual({
        ...original,
        ...update,
      });
      await expect(
        tasks.runs.update('run-missing', { status: 'running' }),
      ).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [owner],
        runs: [{ ...original, ...update }],
      });
    });

    it('rejects Task and Run records scoped to another Space', async () => {
      const { tasks, canvasId } = await open();
      const owner = task(canvasId, 'task-scope', 1);

      await expect(
        tasks.create({ ...owner, canvasId: 'another-space' }),
      ).rejects.toThrow();
      await tasks.create(owner);
      await expect(
        tasks.runs.create({
          ...run(canvasId, owner.taskId, 'run-scope', 2),
          canvasIdSnapshot: 'another-space',
        }),
      ).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [owner],
        runs: [],
      });
    });

    it('rejects malformed Task, Run, and Run-update input', async () => {
      const { tasks, canvasId } = await open();
      const owner = task(canvasId, 'task-validation', 1);
      const ownedRun = run(canvasId, owner.taskId, 'run-validation', 2);

      await expect(tasks.create({ ...owner, goal: '' })).rejects.toThrow();
      await tasks.create(owner);
      await expect(
        tasks.runs.create({ ...ownedRun, goalSnapshot: '' }),
      ).rejects.toThrow();
      await tasks.runs.create(ownedRun);
      await expect(
        tasks.runs.update(ownedRun.runId, { startedAt: -1 }),
      ).rejects.toThrow();
      await expect(tasks.read()).resolves.toEqual({
        version: 1,
        tasks: [owner],
        runs: [ownedRun],
      });
    });

    it('preserves concurrent mutations through two retained handles', async () => {
      const { tasks, concurrent, canvasId } = await open();
      const taskA = task(canvasId, 'task-concurrent-a', 1);
      const taskB = task(canvasId, 'task-concurrent-b', 2);
      await Promise.all([tasks.create(taskA), concurrent.create(taskB)]);

      const runA = run(canvasId, taskA.taskId, 'run-concurrent-a', 3);
      const runB = run(canvasId, taskB.taskId, 'run-concurrent-b', 4);
      await Promise.all([
        tasks.runs.create(runA),
        concurrent.runs.create(runB),
      ]);
      await Promise.all([
        concurrent.runs.update(runA.runId, {
          status: 'running',
          startedAt: 5,
        }),
        tasks.runs.update(runB.runId, {
          status: 'running',
          startedAt: 6,
        }),
      ]);

      const snapshot = await tasks.read();
      expect(snapshot.tasks.map((record) => record.taskId).sort()).toEqual([
        taskA.taskId,
        taskB.taskId,
      ]);
      expect(snapshot.runs.map((record) => record.runId).sort()).toEqual([
        runA.runId,
        runB.runId,
      ]);
      expect(snapshot.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: runA.runId,
            status: 'running',
            startedAt: 5,
          }),
          expect.objectContaining({
            runId: runB.runId,
            status: 'running',
            startedAt: 6,
          }),
        ]),
      );
    });

    it('rejects every mutation for a missing Space', async () => {
      const { missing, missingCanvasId } = await open();
      const owner = task(missingCanvasId, 'task-missing-space', 1);
      const ownedRun = run(
        missingCanvasId,
        owner.taskId,
        'run-missing-space',
        2,
      );

      await expect(missing.create(owner)).rejects.toThrow();
      await expect(missing.runs.create(ownedRun)).rejects.toThrow();
      await expect(
        missing.runs.update(ownedRun.runId, { status: 'running' }),
      ).rejects.toThrow();
    });

    it('rejects mutations while structured deletion is fenced', async () => {
      const { tasks, canvasId, beginDelete } = await open();
      const owner = task(canvasId, 'task-delete-fence', 1);
      const original = run(canvasId, owner.taskId, 'run-delete-fence', 2);
      await tasks.create(owner);
      await tasks.runs.create(original);
      const before = await tasks.read();
      const session = await beginDelete();

      try {
        await expect(
          tasks.create(task(canvasId, 'task-too-late', 3)),
        ).rejects.toThrow();
        await expect(
          tasks.runs.create(run(canvasId, owner.taskId, 'run-too-late', 4)),
        ).rejects.toThrow();
        await expect(
          tasks.runs.update(original.runId, { status: 'running' }),
        ).rejects.toThrow();
        await expect(tasks.read()).resolves.toEqual(before);
      } finally {
        await session.abort();
      }

      await expect(
        tasks.runs.update(original.runId, {
          status: 'running',
          startedAt: 5,
        }),
      ).resolves.toMatchObject({ status: 'running', startedAt: 5 });
    });
  });
}
