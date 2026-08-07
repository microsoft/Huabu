// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DesktopSecureSecretStore, isDesktopSecretId } from './secure-secrets';

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
    const id = 'llm:provider:openai:api-key';
    const store = new DesktopSecureSecretStore(dataDir, codec);

    store.set(id, 'chat-secret');
    store.set('oauth:github-copilot:credentials', 'refresh-secret');

    expect(store.snapshot()).toEqual({
      [id]: 'chat-secret',
      'oauth:github-copilot:credentials': 'refresh-secret',
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
    const id = 'llm:provider:openai:api-key';
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

    expect(() => store.set('integration:tavily:api-key', 'keep-me')).toThrow(
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
  // atomic batch needs a `secret:mutateMany` bridge message routed to a new
  // DesktopSecureSecretStore.setMany.
  // See docs/proposals/credential-storage-hardening-followups.md (item 1).
  it.todo('applies a multi-key batch write atomically via a batch IPC message');
});

// The bridge validates ids by shape, not against a copy of the server's
// `SECRET_IDS`. These cases pin the shape wide enough to cover every id the
// server can generate today (and any future one following the same scheme)
// while still rejecting junk. See docs/architecture/credential-storage.md.
describe('isDesktopSecretId', () => {
  it('accepts every id shape the server can generate', () => {
    for (const id of [
      'llm:image:api-key',
      'llm:provider:openai:api-key',
      'llm:provider:azure-openai:api-key',
      'llm:provider:a.b_c-1:api-key',
      'integration:tavily:api-key',
      'integration:rapidapi:api-key',
      'oauth:github-copilot:credentials',
      'oauth:openai-codex:credentials',
    ]) {
      expect(isDesktopSecretId(id), `rejected a valid id: ${id}`).toBe(true);
    }
  });

  it('rejects malformed, foreign, or oversized ids', () => {
    for (const id of [
      '',
      'llm',
      'llm:provider::api-key',
      'llm:a:b:c:d',
      'whatever:x:y',
      '../../etc/passwd',
      `llm:x:${'a'.repeat(300)}`,
    ]) {
      expect(isDesktopSecretId(id), `accepted an invalid id: ${id}`).toBe(
        false,
      );
    }
  });
});
