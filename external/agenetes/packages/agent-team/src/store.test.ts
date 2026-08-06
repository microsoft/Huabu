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
    ).toMatchObject({ schemaVersion: 3, state });
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
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'registry.json'), 'utf8')),
    ).toMatchObject({ schemaVersion: 3 });
    expect(
      readFileSync(join(storageDir, 'legacy-deployment.setup.jsonl'), 'utf8'),
    ).toBe('');
  });

  it('migrates schema v2 embedded setup logs to sibling JSONL', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 2,
        state: {
          ...state,
          profiles: [
            {
              ...state.profiles[0],
              setupLog: [
                {
                  receivedAt: 101,
                  phase: 'installing_tools',
                  status: 'started',
                  message: 'Installing CLI tools',
                },
              ],
            },
          ],
        },
      }),
    );

    const store = new FileAgentTeamRegistryStore(storageDir);
    expect(store.load()).toEqual(state);
    expect(store.loadSetupLog('profile-1')).toEqual([
      {
        receivedAt: 101,
        phase: 'installing_tools',
        status: 'started',
        message: 'Installing CLI tools',
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'registry.json'), 'utf8')),
    ).toEqual({ schemaVersion: 3, state });
  });

  // Proving the 200-entry cap means rewriting the log 200 times, and each
  // rewrite is a synchronous write + rename + chmod. That is ~600 filesystem
  // round trips: about half a second on an idle machine, but ten times that
  // when the rest of the suite is competing for the same disk, which the
  // default 5s budget cannot absorb.
  it('appends, resets, and deletes sibling setup logs', () => {
    const storageDir = createStorageDir();
    const store = new FileAgentTeamRegistryStore(storageDir);
    const entry = {
      receivedAt: 101,
      phase: 'installing_tools',
      status: 'started' as const,
      message: 'Installing CLI tools',
    };

    store.appendSetupLog('profile-1', entry);
    expect(store.loadSetupLog('profile-1')).toEqual([entry]);
    expect(
      readFileSync(join(storageDir, 'profile-1.setup.jsonl'), 'utf8'),
    ).toBe(`${JSON.stringify(entry)}\n`);

    for (let receivedAt = 102; receivedAt <= 301; receivedAt += 1) {
      store.appendSetupLog('profile-1', { ...entry, receivedAt });
    }
    const bounded = store.loadSetupLog('profile-1');
    expect(bounded).toHaveLength(200);
    expect(bounded[0]?.receivedAt).toBe(102);

    store.resetSetupLog('profile-1');
    expect(store.loadSetupLog('profile-1')).toEqual([]);
    store.deleteSetupLog('profile-1');
    expect(existsSync(join(storageDir, 'profile-1.setup.jsonl'))).toBe(false);
  }, 30_000);

  it('fails explicitly without appending to a malformed setup log', () => {
    const storageDir = createStorageDir();
    const path = join(storageDir, 'profile-1.setup.jsonl');
    writeFileSync(path, '{malformed}\n');
    const store = new FileAgentTeamRegistryStore(storageDir);

    expect(() =>
      store.appendSetupLog('profile-1', {
        receivedAt: 101,
        phase: 'installing_tools',
        status: 'started',
        message: 'Installing CLI tools',
      }),
    ).toThrow('Failed to read Agent Team setup log for profile-1');
    expect(readFileSync(path, 'utf8')).toBe('{malformed}\n');
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
