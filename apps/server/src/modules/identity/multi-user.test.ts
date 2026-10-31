// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { migrateSpaceGrants } from './bubble.js';
import { describeSeveralPeople } from './multi-user.scenarios.js';
import { storageResourceDirectory } from './resources.js';
import { canvasJsonPath } from '../storage/backends/disk/layout.js';
import {
  closeStorage,
  createSpace,
  resetStorageCache,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-multi-user-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  mkdirSync(join(tmp, 'server'));
  resetStorageCache();
  // The Server's own Workspace, where the administrator lands.
  setWorkspacePath(join(tmp, 'server'));
});
afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describeSeveralPeople('Disk', () => tmp);

it('preserves legacy ownership while a registered Disk Workspace is offline, then migrates it on recovery', async () => {
  const store = new InMemoryBubbleStore();
  await createSpace('canvas-legacy', 'Legacy');
  await store.grants.add({
    target: { type: 'huabu.space', id: 'canvas-legacy' },
    principalId: 'carol',
    role: 'huabu.space.owner',
    grantedByPrincipalId: null,
  });
  renameSync(join(tmp, 'server'), join(tmp, 'offline'));
  await migrateSpaceGrants(store, storageResourceDirectory);
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: 'canvas-legacy' },
  ]);
  renameSync(join(tmp, 'offline'), join(tmp, 'server'));
  await migrateSpaceGrants(store, storageResourceDirectory);
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: expect.stringMatching(/:canvas-legacy$/) },
  ]);
});

it('propagates a Space read failure without removing its legacy ownership grant', async () => {
  const store = new InMemoryBubbleStore();
  await createSpace('canvas-legacy', 'Legacy');
  await store.grants.add({
    target: { type: 'huabu.space', id: 'canvas-legacy' },
    principalId: 'carol',
    role: 'huabu.space.owner',
    grantedByPrincipalId: null,
  });
  const recordPath = canvasJsonPath('canvas-legacy');
  rmSync(recordPath);
  mkdirSync(recordPath);
  await expect(
    migrateSpaceGrants(store, storageResourceDirectory),
  ).rejects.toThrow();
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: 'canvas-legacy' },
  ]);
});
