// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_CHANGE_REVIEW_CONFIG,
  getAgentChangeReviewConfig,
  setAgentChangeReviewConfig,
} from './change-review-config.js';

describe('Agent change-review config', () => {
  let dataDir: string;
  const originalDataDir = process.env.HUABU_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-change-review-config-'));
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

  it('defaults to explicit review when no config has been persisted', () => {
    expect(getAgentChangeReviewConfig()).toEqual(
      DEFAULT_AGENT_CHANGE_REVIEW_CONFIG,
    );
  });

  it('persists automatic acceptance atomically', () => {
    expect(
      setAgentChangeReviewConfig({ autoAcceptSpaceChanges: true }),
    ).toEqual({ autoAcceptSpaceChanges: true });
    expect(getAgentChangeReviewConfig()).toEqual({
      autoAcceptSpaceChanges: true,
    });
    expect(
      JSON.parse(
        readFileSync(join(dataDir, 'agent-change-review-config.json'), 'utf8'),
      ),
    ).toEqual({ autoAcceptSpaceChanges: true });
  });

  it('uses the conservative default for invalid persisted data', () => {
    writeFileSync(
      join(dataDir, 'agent-change-review-config.json'),
      JSON.stringify({ autoAcceptSpaceChanges: 'yes' }),
      'utf8',
    );

    expect(getAgentChangeReviewConfig()).toEqual(
      DEFAULT_AGENT_CHANGE_REVIEW_CONFIG,
    );
  });

  it('rejects unknown configuration fields', () => {
    expect(() =>
      setAgentChangeReviewConfig({
        autoAcceptSpaceChanges: true,
        extra: true,
      } as never),
    ).toThrow();
  });
});
