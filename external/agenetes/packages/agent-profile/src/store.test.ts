import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentProfileRegistry } from './create.js';
import { FileAgentProfileRegistryStore } from './store.js';

import type { AgentProfile } from './types.js';

const directories: string[] = [];
function directory(): string {
  const path = resolve(`.profile-test-${randomUUID()}`);
  mkdirSync(path);
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const profile: AgentProfile = {
  id: 'stable',
  alias: 'User edited',
  agentletId: 'target',
  workingDirPath: '/custom/work',
  launch: { kind: 'acp-command', command: 'custom-agent --some "user flags"' },
  metadata: { cliId: 'copilot' },
  customData: {
    provisioning: { id: 'old' },
    nested: [null, true, 3, ' verbatim '],
  },
};

describe('Profile storage and one-time migration', () => {
  it.each([2, 3])(
    'imports only commands from old schema %s without modifying its bytes',
    (schemaVersion) => {
      const legacyStorageDir = directory();
      const storageDir = directory();
      const original = JSON.stringify(
        {
          schemaVersion,
          state: {
            profiles: [
              profile,
              { id: 'retired', launch: { kind: 'agent-team-manifest' } },
            ],
            roots: [{ opaque: 'legacy' }],
            members: [],
            configs: [{ secret: 'retired' }],
          },
        },
        null,
        3,
      );
      writeFileSync(join(legacyStorageDir, 'registry.json'), original);
      const registry = createAgentProfileRegistry({
        storageDir,
        legacyStorageDir,
      });
      expect(registry.listProfiles()).toEqual([profile]);
      expect(
        readFileSync(join(legacyStorageDir, 'registry.json'), 'utf8'),
      ).toBe(original);
      registry.deleteProfile('stable');
      expect(
        createAgentProfileRegistry({
          storageDir,
          legacyStorageDir,
        }).listProfiles(),
      ).toEqual([]);
    },
  );

  it('makes even empty initialization authoritative over both legacy sources', () => {
    const storageDir = directory();
    createAgentProfileRegistry({ storageDir });
    const legacyStorageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      'malformed old data',
    );
    const registry = createAgentProfileRegistry({
      storageDir,
      legacyStorageDir,
      legacyCommandProfiles: [
        {
          id: 'resurrection',
          alias: 'Old',
          agentletId: 'target',
          workingDirPath: '/old',
          command: 'old',
        },
      ],
    });
    expect(registry.listProfiles()).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'registry.json'), 'utf8')),
    ).toEqual({ schemaVersion: 1, state: { profiles: [] } });
  });

  it('ignores v1 Team deployments and initializes the new file', () => {
    const legacyStorageDir = directory();
    const storageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: { deployments: [{ id: 'retired' }] },
      }),
    );
    expect(
      createAgentProfileRegistry({
        storageDir,
        legacyStorageDir,
      }).listProfiles(),
    ).toEqual([]);
    expect(existsSync(join(storageDir, 'registry.json'))).toBe(true);
  });

  it.each([
    'broken json',
    JSON.stringify({
      schemaVersion: 3,
      state: {
        profiles: [{ ...profile, launch: { kind: 'acp-command', command: 2 } }],
      },
    }),
    JSON.stringify({
      schemaVersion: 2,
      state: { profiles: [profile, profile] },
    }),
  ])(
    'fails malformed legacy data without finalizing an empty import',
    (contents) => {
      const storageDir = directory();
      const legacyStorageDir = directory();
      writeFileSync(join(legacyStorageDir, 'registry.json'), contents);
      expect(() =>
        createAgentProfileRegistry({ storageDir, legacyStorageDir }),
      ).toThrow();
      expect(existsSync(join(storageDir, 'registry.json'))).toBe(false);
      expect(
        readFileSync(join(legacyStorageDir, 'registry.json'), 'utf8'),
      ).toBe(contents);
    },
  );

  it('rejects conflicting legacy sources before committing', () => {
    const storageDir = directory();
    const legacyStorageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      JSON.stringify({ schemaVersion: 3, state: { profiles: [profile] } }),
    );
    expect(() =>
      createAgentProfileRegistry({
        storageDir,
        legacyStorageDir,
        legacyCommandProfiles: [
          {
            id: profile.id,
            alias: profile.alias,
            agentletId: profile.agentletId,
            workingDirPath: profile.workingDirPath,
            command: 'different',
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(existsSync(join(storageDir, 'registry.json'))).toBe(false);
  });

  it('imports older ordinary command records with original IDs and opaque host data', () => {
    const storageDir = directory();
    const registry = createAgentProfileRegistry({
      storageDir,
      legacyCommandProfiles: [
        {
          id: profile.id,
          alias: profile.alias,
          agentletId: profile.agentletId,
          workingDirPath: profile.workingDirPath,
          command: profile.launch.command,
          metadata: profile.metadata,
          customData: profile.customData,
        },
      ],
    });
    expect(registry.listProfiles()).toEqual([profile]);
    expect(createAgentProfileRegistry({ storageDir }).listProfiles()).toEqual([
      profile,
    ]);
  });

  it('round trips snapshots atomically and rejects retired launches in the neutral file', () => {
    const storageDir = directory();
    const store = new FileAgentProfileRegistryStore(storageDir);
    store.save({ profiles: [profile] });
    expect(store.load()).toEqual({ profiles: [profile] });
    expect(existsSync(join(storageDir, 'registry.json.pending'))).toBe(false);
    writeFileSync(
      join(storageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: {
          profiles: [{ ...profile, launch: { kind: 'agent-team-manifest' } }],
        },
      }),
    );
    expect(() => createAgentProfileRegistry({ storageDir })).toThrow();
    expect(() => new FileAgentProfileRegistryStore('relative')).toThrow(
      'must be absolute',
    );
  });
});
