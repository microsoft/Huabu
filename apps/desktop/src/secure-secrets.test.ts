import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_SECRET_IDS,
  DesktopSecureSecretStore,
  desktopLlmProviderApiKeySecretId,
} from './secure-secrets';

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
});
