// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDeviceNames, renameDevice } from './device-names.js';

describe('persisted device names', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-device-names-'));
    vi.stubEnv('HUABU_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists independent names by exact identity across subsequent reads', () => {
    expect(getDeviceNames()).toEqual({});
    renameDevice('windows', 'Office PC');
    renameDevice('wsl', 'Linux');
    renameDevice('windows', '  Desktop  ');
    expect(getDeviceNames()).toEqual({ windows: 'Desktop', wsl: 'Linux' });
    expect(
      JSON.parse(
        readFileSync(join(dataDir, 'agentlet-device-names.json'), 'utf8'),
      ),
    ).toEqual({
      windows: 'Desktop',
      wsl: 'Linux',
    });
  });

  it.each(['{broken', 'null', '{"windows":""}'])(
    'refuses to overwrite damaged storage: %s',
    (content) => {
      const path = join(dataDir, 'agentlet-device-names.json');
      writeFileSync(path, content);
      expect(() => getDeviceNames()).toThrow();
      expect(() => renameDevice('windows', 'New')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(content);
    },
  );
});
