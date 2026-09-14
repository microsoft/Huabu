// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { SqlSpaceTasks, validateSnapshot } from './space-tasks.js';
import { run, task } from './test-fixtures.js';

import type { TaskStoreSnapshot } from '@huabu/shared';
it.each([
  { version: 2, tasks: [], runs: [] },
  { version: 1, tasks: [task(), task()], runs: [] },
  { version: 1, tasks: [{ ...task(), canvasId: 'other' }], runs: [] },
  { version: 1, tasks: [], runs: [run()] },
  { version: 1, tasks: [task()], runs: [run(), run()] },
  {
    version: 1,
    tasks: [task()],
    runs: [{ ...run(), canvasIdSnapshot: 'other' }],
  },
])('rejects inconsistent persisted snapshots %j', (snapshot) => {
  expect(() => validateSnapshot(snapshot, 'space')).toThrow(SyntaxError);
});
it('enforces task/run ownership, validation, and immutable first completion', async () => {
  const snapshot: TaskStoreSnapshot = { version: 1, tasks: [], runs: [] };
  const tasks = new SqlSpaceTasks(
    () => structuredClone(snapshot),
    (apply) => apply(snapshot),
    'space',
  );
  await expect(tasks.runs.create(run())).rejects.toThrow(/does not exist/);
  await tasks.create(task());
  await expect(tasks.create(task())).rejects.toThrow(/already exists/);
  await tasks.runs.create(run());
  await expect(tasks.runs.create(run())).rejects.toThrow(/already exists/);
  await expect(
    tasks.runs.complete('task', 'run', { completedAt: 3 }),
  ).resolves.toMatchObject({ outcome: 'run_not_running' });
  await expect(tasks.runs.update('missing', {})).rejects.toThrow(
    /does not exist/,
  );
  await expect(tasks.runs.update('run', { startedAt: -1 })).rejects.toThrow(
    /Invalid update/,
  );
  await tasks.runs.update('run', { status: 'running', startedAt: 3 });
  for (const [taskId, runId, outcome] of [
    ['missing', 'run', 'task_not_found'],
    ['task', 'missing', 'run_not_found'],
  ]) {
    expect(
      await tasks.runs.complete(taskId, runId, { completedAt: 4 }),
    ).toEqual({ outcome });
  }
  expect(
    (
      await tasks.runs.complete('task', 'run', {
        completedAt: 4,
        message: 'done',
      })
    ).outcome,
  ).toBe('completed');
  expect(
    (
      await tasks.runs.complete('task', 'run', {
        completedAt: 5,
        message: 'done',
      })
    ).outcome,
  ).toBe('unchanged');
  expect(
    (
      await tasks.runs.complete('task', 'run', {
        completedAt: 6,
        message: 'different',
      })
    ).outcome,
  ).toBe('completion_conflict');
  expect((await tasks.read()).runs[0].completion).toEqual({
    completedAt: 4,
    message: 'done',
  });
});
