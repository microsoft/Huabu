// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listProfiles } from './profile-store.js';

let directory: string;
let previousDataDir: string | undefined;

const commandProfile = {
  id: 'command',
  displayName: 'Copilot',
  cliId: 'copilot',
  command: 'copilot --acp',
  cwd: '/workspace',
  autoRestart: true,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'huabu-legacy-profiles-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = directory;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
});

describe('read-only legacy Profile import source', () => {
  it('returns no records for an absent file', () => {
    expect(listProfiles()).toEqual([]);
  });

  it('reads ordinary Profiles without rewriting retired Team data', () => {
    const file = join(directory, 'agent-profiles.json');
    const original = JSON.stringify({
      schemaVersion: 1,
      profiles: [
        commandProfile,
        {
          id: 'retired-team',
          cliId: 'agent-team',
          agentTeam: { agentDir: '/team' },
        },
        { ...commandProfile, id: 'team-disguised-as-command', agentTeam: {} },
      ],
    });
    writeFileSync(file, original);
    expect(listProfiles()).toEqual([commandProfile]);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it.each([
    '{"profiles": []}',
    '{"schemaVersion": 999, "profiles": []}',
    '{"schemaVersion": 1, "profiles": [{}]}',
    '{invalid',
  ])(
    'rejects corrupt or unsupported data rather than silently losing it',
    (text) => {
      writeFileSync(join(directory, 'agent-profiles.json'), text);
      expect(() => listProfiles()).toThrow();
    },
  );
});
