import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_SECRET_IDS,
  DesktopSecureSecretStore,
  isDesktopSecretId,
} from './secure-secrets';
import {
  isSecretId,
  llmProviderApiKeySecretId,
  SECRET_IDS as SERVER_SECRET_IDS,
} from '../../server/src/security/secret-ids';

const directories: string[] = [];
const codec = {
  encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf-8'),
  decryptString: (value: Buffer) =>
    value.toString('utf-8').replace(/^protected:/, ''),
};

function createDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'huabu-secrets-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true });
  directories.length = 0;
});

describe('DesktopSecureSecretStore', () => {
  it('encrypts values at rest and round-trips them through the vault', () => {
    const dataDir = createDataDir();
    const id = llmProviderApiKeySecretId('openai');
    const store = new DesktopSecureSecretStore(dataDir, codec);

    store.set(id, 'chat-secret');
    store.set(DESKTOP_SECRET_IDS.copilotOAuth, 'refresh-secret');

    expect(store.snapshot()).toEqual({
      [id]: 'chat-secret',
      [DESKTOP_SECRET_IDS.copilotOAuth]: 'refresh-secret',
    });
    const encrypted = readFileSync(
      join(dataDir, 'secure-secrets.json'),
      'utf-8',
    );
    expect(encrypted).not.toContain('chat-secret');
    expect(encrypted).not.toContain('refresh-secret');

    // A reopened store must see exactly what the previous one persisted.
    expect(new DesktopSecureSecretStore(dataDir, codec).snapshot()).toEqual(
      store.snapshot(),
    );
  });

  it('removes an entry when a null value is written', () => {
    const dataDir = createDataDir();
    const id = llmProviderApiKeySecretId('openai');
    const store = new DesktopSecureSecretStore(dataDir, codec);

    store.set(id, 'chat-secret');
    store.set(id, null);

    expect(store.snapshot()).toEqual({});
    expect(new DesktopSecureSecretStore(dataDir, codec).snapshot()).toEqual({});
  });

  it('rejects a write whose encryption does not survive a decrypt check', () => {
    const dataDir = createDataDir();
    const brokenCodec = {
      encryptString: (value: string) => Buffer.from(value, 'utf-8'),
      decryptString: () => 'wrong-value',
    };
    const store = new DesktopSecureSecretStore(dataDir, brokenCodec);

    expect(() => store.set(DESKTOP_SECRET_IDS.tavilyApiKey, 'keep-me')).toThrow(
      'Secure credential encryption verification failed',
    );
  });

  it('refuses to load a corrupt vault instead of treating it as empty', () => {
    const dataDir = createDataDir();
    const vaultPath = join(dataDir, 'secure-secrets.json');
    writeFileSync(vaultPath, '{ this is not valid json');
    const before = readFileSync(vaultPath, 'utf-8');

    expect(() => new DesktopSecureSecretStore(dataDir, codec)).toThrow(
      /corrupted credential file/i,
    );
    // A failed load must never overwrite the damaged file.
    expect(readFileSync(vaultPath, 'utf-8')).toBe(before);
  });

  it('refuses a vault with an unsupported version', () => {
    const dataDir = createDataDir();
    writeFileSync(
      join(dataDir, 'secure-secrets.json'),
      JSON.stringify({ version: 2, entries: {} }),
    );

    expect(() => new DesktopSecureSecretStore(dataDir, codec)).toThrow(
      /unsupported secure credential file version/i,
    );
  });

  // Deferred: desktop multi-key writes go through ElectronSecretStore.setMany,
  // which currently loops one IPC round-trip per key (not atomic). A real
  // atomic batch needs a `secret:mutateMany` bridge message routed to
  // DesktopSecureSecretStore.setMany.
  // See docs/proposals/credential-storage-hardening-followups.md (item 1).
  it.todo('applies a multi-key batch write atomically via a batch IPC message');
});

// The secret-id contract is hand-duplicated between the server and this
// package because apps/desktop is compiled by plain tsc and cannot consume the
// raw-TypeScript @sediment/shared package. Drift is silent and severe: an id
// the server writes but the main process does not whitelist is rejected as
// "Invalid secure credential mutation" long before safeStorage is reached.
// See docs/proposals/credential-storage-hardening-followups.md (item 3) for
// the permanent fix.
describe('secret-id parity with the server contract', () => {
  it('accepts every server secret id', () => {
    for (const id of Object.values(SERVER_SECRET_IDS)) {
      expect(isDesktopSecretId(id), `server id not whitelisted: ${id}`).toBe(
        true,
      );
    }
  });

  it('exposes exactly the server secret id set', () => {
    expect(Object.entries(DESKTOP_SECRET_IDS).sort()).toEqual(
      Object.entries(SERVER_SECRET_IDS).sort(),
    );
  });

  it('derives provider api-key ids identically to the server', () => {
    for (const provider of ['openai', 'azure-openai', 'a.b_c-1']) {
      expect(isDesktopSecretId(llmProviderApiKeySecretId(provider))).toBe(true);
    }
  });

  it('rejects ids the server also rejects', () => {
    for (const id of [
      '',
      'oauth:unknown:credentials',
      'llm:provider::api-key',
    ]) {
      expect(isDesktopSecretId(id)).toBe(isSecretId(id));
    }
  });
});
