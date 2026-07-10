import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EncryptedFileSecretStore } from './encrypted-file-secret-store.js';
import { migratePlaintextCredentials } from './plaintext-secret-migration.js';
import { llmProviderApiKeySecretId, SECRET_IDS } from './secret-ids.js';

const directories: string[] = [];
const key = Buffer.alloc(32, 7);

function createDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'huabu-server-secrets-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true });
  directories.length = 0;
});

describe('EncryptedFileSecretStore', () => {
  it('persists authenticated ciphertext without plaintext', async () => {
    const dataDir = createDataDir();
    const store = new EncryptedFileSecretStore(dataDir, key);
    await store.initialize();
    await store.set('test:credential', 'private-value');

    const raw = readFileSync(join(dataDir, 'encrypted-secrets.json'), 'utf-8');
    expect(raw).not.toContain('private-value');

    const restored = new EncryptedFileSecretStore(dataDir, key);
    await restored.initialize();
    expect(restored.get('test:credential')).toBe('private-value');
  });

  it('fails closed when ciphertext is modified or the key is wrong', async () => {
    const dataDir = createDataDir();
    const store = new EncryptedFileSecretStore(dataDir, key);
    await store.initialize();
    await store.set('test:credential', 'private-value');

    const path = join(dataDir, 'encrypted-secrets.json');
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    persisted.entries['test:credential'].ciphertext =
      Buffer.from('tampered').toString('base64');
    writeFileSync(path, JSON.stringify(persisted));

    await expect(
      new EncryptedFileSecretStore(dataDir, key).initialize(),
    ).rejects.toThrow('Failed to decrypt credential');
    await expect(
      new EncryptedFileSecretStore(dataDir, Buffer.alloc(32, 8)).initialize(),
    ).rejects.toThrow('does not match');
  });

  it('migrates legacy plaintext only after encrypted verification', async () => {
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
      JSON.stringify({ tavilyApiKey: 'tavily-secret' }),
    );
    writeFileSync(
      join(dataDir, 'oauth-credentials.json'),
      JSON.stringify({ refresh: 'refresh-secret', access: 'access-secret' }),
    );

    const store = new EncryptedFileSecretStore(dataDir, key);
    await store.initialize();
    await migratePlaintextCredentials(dataDir, store);
    await migratePlaintextCredentials(dataDir, store);

    expect(store.get(llmProviderApiKeySecretId('openai'))).toBe('chat-secret');
    expect(store.get(SECRET_IDS.imageApiKey)).toBe('image-secret');
    expect(store.get(SECRET_IDS.tavilyApiKey)).toBe('tavily-secret');
    expect(store.get(SECRET_IDS.copilotOAuth)).toContain('refresh-secret');
    expect(
      JSON.parse(readFileSync(join(dataDir, 'llm-config.json'), 'utf-8'))
        .providers.openai.apiKey,
    ).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(dataDir, 'integrations.json'), 'utf-8')),
    ).toEqual({});
    expect(
      JSON.parse(
        readFileSync(join(dataDir, 'oauth-credentials.json'), 'utf-8'),
      ),
    ).toEqual({});
    expect(
      readFileSync(join(dataDir, 'encrypted-secrets.json'), 'utf-8'),
    ).not.toContain('chat-secret');
  });
});
