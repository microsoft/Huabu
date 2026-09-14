// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { unitContext } from './unit-test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
it('validates names before creating or ensuring a default workspace', async () => {
  const h = unitContext();
  const repo = new PostgresWorkspaceRepository(h.context);
  await expect(repo.create(' ')).rejects.toThrow(/empty/);
  await expect(repo.ensureDefault(' ')).rejects.toThrow(/empty/);
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.transaction).not.toHaveBeenCalled();
});
it('reuses an existing default workspace and records activation', async () => {
  const h = unitContext();
  h.get.mockResolvedValue({ workspace_id: 'existing', name: 'Existing' });
  expect(
    await new PostgresWorkspaceRepository(h.context).ensureDefault('New'),
  ).toEqual({ workspaceId: 'existing', name: 'Existing' });
  expect(h.execute).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE workspaces'),
    1,
    'existing',
  );
});
it('forgets membership without deleting owned data and reports absent ids', async () => {
  const h = unitContext();
  const repo = new PostgresWorkspaceRepository(h.context);
  expect(await repo.remove('absent')).toBe(false);
  expect(h.execute).not.toHaveBeenCalled();
  h.get.mockResolvedValue({ workspace_id: 'existing', name: 'Existing' });
  expect(await repo.remove('existing')).toBe(true);
  expect(h.execute).toHaveBeenCalledWith(
    expect.stringContaining('SET forgotten_at'),
    1,
    'existing',
  );
});
