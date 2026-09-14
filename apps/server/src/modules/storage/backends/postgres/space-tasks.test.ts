// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { PostgresSpaceTasks } from './space-tasks.js';
import { unitContext } from './unit-test-support.js';
import { task } from '../sql/test-fixtures.js';
it('does not read another workspace task snapshot when the space is absent', async () => {
  const h = unitContext();
  const tasks = new PostgresSpaceTasks(h.context, 'workspace', 'space');
  expect(await tasks.read()).toEqual({ version: 1, tasks: [], runs: [] });
  expect(h.get).toHaveBeenCalledTimes(1);
  await expect(tasks.create(task())).rejects.toThrow(/missing Space/);
  expect(h.execute).not.toHaveBeenCalled();
});
it('rejects corrupt snapshots without replacing them', async () => {
  const h = unitContext();
  h.get
    .mockResolvedValueOnce({ present: 1 })
    .mockResolvedValueOnce({ snapshot_json: '{}' });
  await expect(
    new PostgresSpaceTasks(h.context, 'workspace', 'space').create(task()),
  ).rejects.toThrow(/Invalid Task store/);
  expect(h.execute).not.toHaveBeenCalled();
});
it('upserts validated task state and rejects a stale workspace handle', async () => {
  const h = unitContext();
  const tasks = new PostgresSpaceTasks(h.context, 'workspace', 'space');
  h.get.mockResolvedValueOnce({ present: 1 }).mockResolvedValueOnce(undefined);
  await tasks.create(task());
  expect(JSON.parse(String(h.execute.mock.calls[0][2]))).toEqual({
    version: 1,
    tasks: [task()],
    runs: [],
  });
  h.context.useWorkspace('other');
  await expect(tasks.read()).rejects.toThrow(/inactive Workspace/);
});
