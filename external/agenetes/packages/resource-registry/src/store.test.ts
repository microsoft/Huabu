import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileResourceRegistryStore } from './store.js';

import type { ResourceRegistryState } from './types.js';

const tempDirs: string[] = [];

function createStorageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenetes-resource-registry-'));
  tempDirs.push(dir);
  return dir;
}

const state: ResourceRegistryState = {
  resources: [
    {
      schemaVersion: 1,
      id: 'huabu-access',
      name: 'Huabu Access',
      provider: 'huabu',
      description: 'Fetch the Huabu Access Skill and follow it.',
      instructions: 'Fetch $HUABU_RFS_URL/skill with the injected token.',
    },
  ],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileResourceRegistryStore', () => {
  it('returns an empty state when no file exists yet', () => {
    const storageDir = createStorageDir();
    expect(new FileResourceRegistryStore(storageDir).load()).toEqual({
      resources: [],
    });
  });

  it('persists and restores a schema-versioned registry atomically', () => {
    const storageDir = createStorageDir();
    const store = new FileResourceRegistryStore(storageDir);

    store.save(state);

    expect(new FileResourceRegistryStore(storageDir).load()).toEqual(state);
    expect(
      JSON.parse(readFileSync(join(storageDir, 'resources.json'), 'utf8')),
    ).toEqual({ schemaVersion: 1, state });
    expect(existsSync(join(storageDir, 'resources.json.tmp'))).toBe(false);
  });

  it('applies owner-only permissions best-effort', () => {
    const storageDir = createStorageDir();
    const store = new FileResourceRegistryStore(storageDir);
    store.save(state);

    if (process.platform !== 'win32') {
      const mode = statSync(join(storageDir, 'resources.json')).mode;
      expect(mode & 0o777).toBe(0o600);
    }
  });

  it('rejects relative storage directories', () => {
    expect(() => new FileResourceRegistryStore('relative/path')).toThrow(
      'must be absolute',
    );
  });

  it('fails closed for an unsupported schema version', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'resources.json'),
      JSON.stringify({ schemaVersion: 2, state }),
    );

    expect(() => new FileResourceRegistryStore(storageDir).load()).toThrow(
      'Unsupported or invalid Resource Registry schema',
    );
  });

  it('fails closed for a malformed resource record', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'resources.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: { resources: [{ ...state.resources[0], id: 'Not Kebab Case' }] },
      }),
    );

    expect(() => new FileResourceRegistryStore(storageDir).load()).toThrow(
      'not a valid AgentResource',
    );
  });

  it('fails closed for a duplicate resource id', () => {
    const storageDir = createStorageDir();
    writeFileSync(
      join(storageDir, 'resources.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: { resources: [state.resources[0], state.resources[0]] },
      }),
    );

    expect(() => new FileResourceRegistryStore(storageDir).load()).toThrow(
      'duplicate resource id',
    );
  });
});
