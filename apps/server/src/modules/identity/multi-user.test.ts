// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { describeSeveralPeople } from './multi-user.scenarios.js';
import { resetStorageCache } from '../storage/index.js';
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
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describeSeveralPeople('Disk', () => tmp);
