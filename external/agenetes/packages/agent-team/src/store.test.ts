import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileAgentTeamRegistryStore } from './store.js';

import type { AgentTeamRegistryState } from './types.js';

const tempDirs: string[] = [];

function createStorageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenetes-agent-team-'));
  tempDirs.push(dir);
  return dir;
}

const state: AgentTeamRegistryState = {
  roots: [
    {
      machine: 'machine-a',
      path: '/teams',
      scan: { status: 'success', scannedAt: 100, diagnostics: [] },
    },
  ],
  members: [
    {
      machine: 'machine-a',
      manifestPath: '/teams/reviewer/agentlet.yaml',
      name: 'reviewer',
      description: 'Reviews changes',
      harnesses: ['copilot'],
      env: [],
      discoveredBy: [{ machine: 'machine-a', path: '/teams' }],
      status: 'active',
    },
  ],
  profiles: [
    {
      id: 'profile-1',
      alias: 'Reviewer',
      agentletId: 'machine-a',
      workingDirPath: '/teams/reviewer/workspaces/copilot',
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        harness: 'copilot',
      },
      preparation: { status: 'not_prepared' },
      setupLog: [],
    },
  ],
  configs: [
    {
      machine: 'machine-a',
      manifestPath: '/teams/reviewer/agentlet.yaml',
      values: { ENDPOINT: 'https://example.test' },
    },
  ],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileAgentTeamRegistryStore', () => {
  it('persists and restores a schema-versioned registry atomically', () => {
    const storageDir = createStorageDir();
    const store = new FileAgentTeamRegistryStore(storageDir);

    store.save(state);

    expect(new FileAgentTeamRegistryStore(storageDir).load()).toEqual(state);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'registry.json'), 'utf8')),
    ).toMatchObject({ schemaVersion: 2, state });
    expect(existsSync(join(storageDir, 'registry.json.tmp'))).toBe(false);
  });

  it('rejects relative storage directories', () => {
    expect(() => new FileAgentTeamRegistryStore('relative/path')).toThrow(
      'must be absolute',
    );
  });

  it('fails closed for malformed persisted state', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: {
          roots: state.roots,
          members: [
            {
              ...state.members[0],
              status: 'active',
              discoveredBy: [],
            },
          ],
        },
      }),
    );

    expect(() => new FileAgentTeamRegistryStore(storageDir).load()).toThrow(
      'member status does not match discovery provenance',
    );
  });

  it('loads discovery-only schema v1 files with no deployments', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: {
          roots: state.roots,
          members: state.members,
        },
      }),
    );

    expect(new FileAgentTeamRegistryStore(storageDir).load()).toEqual({
      ...state,
      profiles: [],
      configs: [],
    });
  });

  it('migrates schema v1 deployments to immutable manifest Profiles', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: {
          roots: state.roots,
          members: state.members,
          deployments: [
            {
              id: 'legacy-deployment',
              alias: 'Reviewer',
              revision: 3,
              enabled: true,
              machine: 'machine-a',
              manifestPath: '/teams/reviewer/agentlet.yaml',
              harness: 'copilot',
              workingDirPath: '/teams/reviewer/workspaces/copilot',
              setup: { status: 'ready', completedAt: 100 },
              setupLog: [],
            },
          ],
          configs: [],
        },
      }),
    );

    expect(new FileAgentTeamRegistryStore(storageDir).load().profiles).toEqual([
      {
        id: 'legacy-deployment',
        alias: 'Reviewer',
        agentletId: 'machine-a',
        workingDirPath: '/teams/reviewer/workspaces/copilot',
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
        },
        preparation: { status: 'ready', completedAt: 100 },
        setupLog: [],
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'registry.json'), 'utf8')),
    ).toMatchObject({ schemaVersion: 2 });
  });

  it('rejects orphan configs even when there are no Profiles', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: {
          roots: state.roots,
          members: state.members,
          deployments: [],
          configs: [
            {
              machine: 'machine-a',
              manifestPath: '/teams/unknown/agentlet.yaml',
              values: { ENDPOINT: 'https://example.test' },
            },
          ],
        },
      }),
    );

    expect(() => new FileAgentTeamRegistryStore(storageDir).load()).toThrow(
      'config references an unknown member',
    );
  });
});
