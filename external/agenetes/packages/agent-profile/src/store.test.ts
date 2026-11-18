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

import type {
  AcpCommandProfile,
  CreateAgentProfileRegistryOptions,
} from './index.js';

/** A registry over `registry.json` in `storageDir`. */
function fileRegistry(
  storageDir: string,
  options: Omit<CreateAgentProfileRegistryOptions, 'store'> = {},
) {
  return createAgentProfileRegistry({
    ...options,
    store: new FileAgentProfileRegistryStore(storageDir),
  });
}

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
const profile: AcpCommandProfile = {
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
    async (schemaVersion) => {
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
      const registry = await fileRegistry(storageDir, {
        legacyStorageDir,
      });
      expect(registry.listProfiles()).toEqual([profile]);
      expect(
        readFileSync(join(legacyStorageDir, 'registry.json'), 'utf8'),
      ).toBe(original);
      await registry.deleteProfile('stable');
      const reopened = await fileRegistry(storageDir, { legacyStorageDir });
      expect(reopened.listProfiles()).toEqual([]);
    },
  );

  it('makes even empty initialization authoritative over both legacy sources', async () => {
    const storageDir = directory();
    await fileRegistry(storageDir);
    const legacyStorageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      'malformed old data',
    );
    const registry = await fileRegistry(storageDir, {
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

  it('ignores v1 Team deployments and initializes the new file', async () => {
    const legacyStorageDir = directory();
    const storageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: { deployments: [{ id: 'retired' }] },
      }),
    );
    const registry = await fileRegistry(storageDir, { legacyStorageDir });
    expect(registry.listProfiles()).toEqual([]);
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
    async (contents) => {
      const storageDir = directory();
      const legacyStorageDir = directory();
      writeFileSync(join(legacyStorageDir, 'registry.json'), contents);
      await expect(
        fileRegistry(storageDir, { legacyStorageDir }),
      ).rejects.toThrow();
      expect(existsSync(join(storageDir, 'registry.json'))).toBe(false);
      expect(
        readFileSync(join(legacyStorageDir, 'registry.json'), 'utf8'),
      ).toBe(contents);
    },
  );

  it('rejects conflicting legacy sources before committing', async () => {
    const storageDir = directory();
    const legacyStorageDir = directory();
    writeFileSync(
      join(legacyStorageDir, 'registry.json'),
      JSON.stringify({ schemaVersion: 3, state: { profiles: [profile] } }),
    );
    await expect(
      fileRegistry(storageDir, {
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
    ).rejects.toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(existsSync(join(storageDir, 'registry.json'))).toBe(false);
  });

  it('imports older ordinary command records with original IDs and opaque host data', async () => {
    const storageDir = directory();
    const registry = await fileRegistry(storageDir, {
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
    expect((await fileRegistry(storageDir)).listProfiles()).toEqual([profile]);
  });

  it('round trips snapshots atomically and rejects retired launches in the neutral file', async () => {
    const storageDir = directory();
    const store = new FileAgentProfileRegistryStore(storageDir);
    expect(store.load()).toBeNull();
    await store.save({ profiles: [profile] });
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
    await expect(fileRegistry(storageDir)).rejects.toThrow();
    expect(() => new FileAgentProfileRegistryStore('relative')).toThrow(
      'must be absolute',
    );
  });
});
