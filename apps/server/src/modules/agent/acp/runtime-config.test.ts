// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG,
  getExternalAgentRuntimeConfig,
  setExternalAgentRuntimeConfig,
} from './runtime-config.js';

describe('external-agent runtime config', () => {
  let dataDir: string;
  const originalDataDir = process.env.HUABU_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-external-agent-config-'));
    process.env.HUABU_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.HUABU_DATA_DIR;
    } else {
      process.env.HUABU_DATA_DIR = originalDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses ten minutes when no config has been persisted', () => {
    expect(getExternalAgentRuntimeConfig()).toEqual(
      DEFAULT_EXTERNAL_AGENT_RUNTIME_CONFIG,
    );
  });

  it('persists disabled idle suspension atomically', () => {
    expect(setExternalAgentRuntimeConfig({ idleTimeoutSecs: 0 })).toEqual({
      idleTimeoutSecs: 0,
    });
    expect(getExternalAgentRuntimeConfig()).toEqual({ idleTimeoutSecs: 0 });
    expect(
      JSON.parse(
        readFileSync(
          join(dataDir, 'external-agent-runtime-config.json'),
          'utf8',
        ),
      ),
    ).toEqual({ idleTimeoutSecs: 0 });
  });

  it('rejects finite timeouts outside one minute through one day', () => {
    expect(() =>
      setExternalAgentRuntimeConfig({ idleTimeoutSecs: 59 }),
    ).toThrow();
    expect(() =>
      setExternalAgentRuntimeConfig({ idleTimeoutSecs: 86_401 }),
    ).toThrow();
    expect(() =>
      setExternalAgentRuntimeConfig({ idleTimeoutSecs: 61 }),
    ).toThrow();
  });
});
