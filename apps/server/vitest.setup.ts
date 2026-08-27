// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

/**
 * Persistent Server stores must never write into the repository during tests.
 * Vitest executes setup files inside each isolated test-file environment, so
 * every file receives its own real data directory without sharing registries
 * with parallel suites.
 */
const previousDataDir = process.env.HUABU_DATA_DIR;
const testDataDir = mkdtempSync(path.join(tmpdir(), 'huabu-server-test-data-'));
process.env.HUABU_DATA_DIR = testDataDir;

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});
