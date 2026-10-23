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
const previousConfigDir = process.env.HUABU_CONFIG_DIR;
const testDataDir = mkdtempSync(path.join(tmpdir(), 'huabu-server-test-data-'));
const testConfigDir = mkdtempSync(
  path.join(tmpdir(), 'huabu-server-test-config-'),
);
process.env.HUABU_DATA_DIR = testDataDir;
process.env.HUABU_CONFIG_DIR = testConfigDir;

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  if (previousConfigDir === undefined) delete process.env.HUABU_CONFIG_DIR;
  else process.env.HUABU_CONFIG_DIR = previousConfigDir;
  rmSync(testDataDir, { recursive: true, force: true });
  rmSync(testConfigDir, { recursive: true, force: true });
});
