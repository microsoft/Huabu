// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DiskServerRecordStore } from './server-records.js';
import { describeServerRecordStoreContract } from '../../ports/contracts/server-records.contract.js';
import {
  SERVER_RECORD_NAMES,
  SERVER_RECORDS,
} from '../../ports/server-records.js';

const directories: string[] = [];
function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-disk-server-records-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describeServerRecordStoreContract('Disk', () => {
  const dataDir = dataDirectory();
  return {
    store: new DiskServerRecordStore(() => dataDir),
    reopen: async () => new DiskServerRecordStore(() => dataDir),
  };
});

const OWNER = 'c'.repeat(32);

describe('Disk server records', () => {
  it('keeps every record in the file earlier versions wrote', async () => {
    const dataDir = dataDirectory();
    const store = new DiskServerRecordStore(() => dataDir);
    for (const name of SERVER_RECORD_NAMES) {
      await store.put({ owner: null, name }, { name });
      if (SERVER_RECORDS[name].personal)
        await store.put({ owner: OWNER, name }, { name, owner: OWNER });
    }
    const files: Record<string, string> = {
      credentials: 'encrypted-secrets.json',
      'model-settings': 'llm-config.json',
      'agent-defaults': 'agent-defaults.json',
      'change-review': 'agent-change-review-config.json',
      'external-agent-runtime': 'external-agent-runtime-config.json',
      'device-names': 'agentlet-device-names.json',
      'device-owners': 'agentlet-owners.json',
      'agent-credential-versions': 'agent-credential-versions.json',
      'agent-profiles': join('agent-profiles', 'registry.json'),
      'user-agent-profiles': join('user-agent-profiles', 'registry.json'),
    };
    expect(Object.keys(files).sort()).toEqual([...SERVER_RECORD_NAMES].sort());
    for (const [name, file] of Object.entries(files)) {
      expect(JSON.parse(readFileSync(join(dataDir, file), 'utf8'))).toEqual({
        name,
      });
      const personal = join(dataDir, 'people', OWNER, file);
      expect(existsSync(personal)).toBe(
        SERVER_RECORDS[name as keyof typeof SERVER_RECORDS].personal,
      );
    }
  });

  it.skipIf(process.platform === 'win32')(
    'leaves every record readable by its owner alone',
    async () => {
      const dataDir = dataDirectory();
      const store = new DiskServerRecordStore(() => dataDir);
      await store.put({ owner: null, name: 'credentials' }, { secret: 1 });
      await store.put({ owner: OWNER, name: 'model-settings' }, { a: 1 });
      expect(
        statSync(join(dataDir, 'encrypted-secrets.json')).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(dataDir, 'people', OWNER, 'llm-config.json')).mode &
          0o777,
      ).toBe(0o600);
    },
  );

  it('lists records only under directories this Server names people by', async () => {
    const dataDir = dataDirectory();
    const store = new DiskServerRecordStore(() => dataDir);
    await store.put({ owner: OWNER, name: 'device-names' }, { d: 'Desk' });
    mkdirSync(join(dataDir, 'people', 'not-a-person'), { recursive: true });
    writeFileSync(
      join(dataDir, 'people', 'not-a-person', 'llm-config.json'),
      '{}',
    );
    // A deployment-only name under a person is not that person's record.
    writeFileSync(join(dataDir, 'people', OWNER, 'agentlet-owners.json'), '{}');

    await expect(store.keys()).resolves.toEqual([
      { owner: OWNER, name: 'device-names' },
    ]);
  });

  it.each(['{broken', 'null'])(
    'reports damaged file %s instead of treating it as absent',
    async (content) => {
      const dataDir = dataDirectory();
      writeFileSync(join(dataDir, 'llm-config.json'), content);
      const store = new DiskServerRecordStore(() => dataDir);
      await expect(
        store.get({ owner: null, name: 'model-settings' }),
      ).rejects.toThrow('Server record model-settings');
    },
  );

  it('follows the data directory in force on every call', async () => {
    let dataDir = dataDirectory();
    const store = new DiskServerRecordStore(() => dataDir);
    await store.put({ owner: null, name: 'agent-defaults' }, { first: true });
    dataDir = dataDirectory();
    expect(await store.get({ owner: null, name: 'agent-defaults' })).toBeNull();
  });
});
