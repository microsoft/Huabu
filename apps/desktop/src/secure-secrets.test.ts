import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_SECRET_IDS,
  DesktopSecureSecretStore,
  desktopLlmProviderApiKeySecretId,
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
  it('migrates all legacy credentials and removes their plaintext fields', () => {
    const dataDir = createDataDir();
    writeFileSync(
      join(dataDir, 'llm-config.json'),
      JSON.stringify({
        active: 'openai',
        providers: { openai: { model: 'gpt', apiKey: 'chat-secret' } },
        imageConfig: { provider: 'azure-openai', apiKey: 'image-secret' },
      }),
    );
    writeFileSync(
      join(dataDir, 'integrations.json'),
      JSON.stringify({
        tavilyApiKey: 'tavily-secret',
        rapidApiKey: 'rapid-secret',
      }),
    );
    writeFileSync(
      join(dataDir, 'oauth-credentials.json'),
      JSON.stringify({ refresh: 'refresh-secret', access: 'access-secret' }),
    );

    const store = new DesktopSecureSecretStore(dataDir, codec);
    store.migratePlaintextFiles();
    store.migratePlaintextFiles();

    expect(store.snapshot()).toMatchObject({
      [desktopLlmProviderApiKeySecretId('openai')]: 'chat-secret',
      [DESKTOP_SECRET_IDS.imageApiKey]: 'image-secret',
      [DESKTOP_SECRET_IDS.tavilyApiKey]: 'tavily-secret',
      [DESKTOP_SECRET_IDS.rapidApiKey]: 'rapid-secret',
    });
    const llm = JSON.parse(
      readFileSync(join(dataDir, 'llm-config.json'), 'utf-8'),
    );
    expect(llm.providers.openai.apiKey).toBeUndefined();
    expect(llm.imageConfig.apiKey).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(dataDir, 'integrations.json'), 'utf-8')),
    ).toEqual({});
    expect(
      JSON.parse(
        readFileSync(join(dataDir, 'oauth-credentials.json'), 'utf-8'),
      ),
    ).toEqual({});
    const encrypted = readFileSync(
      join(dataDir, 'secure-secrets.json'),
      'utf-8',
    );
    expect(encrypted).not.toContain('chat-secret');
    expect(encrypted).not.toContain('refresh-secret');
  });

  it('keeps an existing encrypted value and scrubs stale plaintext', () => {
    const dataDir = createDataDir();
    const store = new DesktopSecureSecretStore(dataDir, codec);
    const id = desktopLlmProviderApiKeySecretId('openai');
    store.set(id, 'new-secret');
    writeFileSync(
      join(dataDir, 'llm-config.json'),
      JSON.stringify({
        active: 'openai',
        providers: { openai: { apiKey: 'stale-secret' } },
      }),
    );

    store.migratePlaintextFiles();
    store.set(id, 'newest-secret');

    expect(store.snapshot()[id]).toBe('newest-secret');
    expect(
      JSON.parse(readFileSync(join(dataDir, 'llm-config.json'), 'utf-8'))
        .providers.openai.apiKey,
    ).toBeUndefined();
  });

  it('retains plaintext when encrypted-value verification fails', () => {
    const dataDir = createDataDir();
    const configPath = join(dataDir, 'integrations.json');
    writeFileSync(configPath, JSON.stringify({ tavilyApiKey: 'keep-me' }));
    const brokenCodec = {
      encryptString: (value: string) => Buffer.from(value, 'utf-8'),
      decryptString: () => 'wrong-value',
    };
    const store = new DesktopSecureSecretStore(dataDir, brokenCodec);

    expect(() => store.migratePlaintextFiles()).toThrow(
      'Secure credential migration verification failed',
    );
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).tavilyApiKey).toBe(
      'keep-me',
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

  it('fails closed on a corrupt legacy config instead of skipping migration', () => {
    const dataDir = createDataDir();
    const configPath = join(dataDir, 'llm-config.json');
    writeFileSync(configPath, '{ broken');
    const store = new DesktopSecureSecretStore(dataDir, codec);

    expect(() => store.migratePlaintextFiles()).toThrow(
      /corrupted credential file/i,
    );
    // The corrupt plaintext must be left untouched, not silently dropped.
    expect(readFileSync(configPath, 'utf-8')).toBe('{ broken');
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
      expect(desktopLlmProviderApiKeySecretId(provider)).toBe(
        llmProviderApiKeySecretId(provider),
      );
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
