// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { describeSeveralPeople } from './multi-user.scenarios.js';
import { closeStorage, initStorage } from '../storage/index.js';

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-multi-user-sqlite-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  await initStorage({
    structured: { kind: 'sqlite' },
    blobs: { kind: 'disk' },
  });
});

afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

describeSeveralPeople('SQLite', () => tmp);
