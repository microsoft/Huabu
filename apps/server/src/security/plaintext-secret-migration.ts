import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { llmProviderApiKeySecretId, SECRET_IDS } from './secret-ids.js';

import type { EncryptedFileSecretStore } from './encrypted-file-secret-store.js';

interface MigrationSource {
  secrets: Record<string, string>;
  scrub(): void;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    throw new Error(`Cannot migrate malformed credential file: ${path}`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Best effort on platforms that support POSIX modes.
  }
  renameSync(temporary, path);
}

function collectLlm(dataDir: string): MigrationSource | null {
  const path = join(dataDir, 'llm-config.json');
  const parsed = readJsonObject(path);
  if (!parsed) return null;
  const secrets: Record<string, string> = {};

  const providers = parsed.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [provider, raw] of Object.entries(providers)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.apiKey === 'string' && entry.apiKey) {
        secrets[llmProviderApiKeySecretId(provider)] = entry.apiKey;
        if (
          provider === 'azure-openai' &&
          (typeof entry.imageModel === 'string' ||
            typeof entry.imageQuality === 'string')
        ) {
          secrets[SECRET_IDS.imageApiKey] = entry.apiKey;
        }
      }
    }
  }
  if (
    typeof parsed.provider === 'string' &&
    typeof parsed.apiKey === 'string' &&
    parsed.apiKey
  ) {
    secrets[llmProviderApiKeySecretId(parsed.provider)] = parsed.apiKey;
    if (
      parsed.provider === 'azure-openai' &&
      (typeof parsed.imageModel === 'string' ||
        typeof parsed.imageQuality === 'string')
    ) {
      secrets[SECRET_IDS.imageApiKey] = parsed.apiKey;
    }
  }
  const image = parsed.imageConfig;
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    const apiKey = (image as Record<string, unknown>).apiKey;
    if (typeof apiKey === 'string' && apiKey) {
      secrets[SECRET_IDS.imageApiKey] = apiKey;
    }
  }

  if (Object.keys(secrets).length === 0) return null;
  return {
    secrets,
    scrub: () => {
      const current = readJsonObject(path);
      if (!current) return;
      delete current.apiKey;
      const currentProviders = current.providers;
      if (
        currentProviders &&
        typeof currentProviders === 'object' &&
        !Array.isArray(currentProviders)
      ) {
        for (const raw of Object.values(currentProviders)) {
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            delete (raw as Record<string, unknown>).apiKey;
          }
        }
      }
      const currentImage = current.imageConfig;
      if (
        currentImage &&
        typeof currentImage === 'object' &&
        !Array.isArray(currentImage)
      ) {
        delete (currentImage as Record<string, unknown>).apiKey;
      }
      writeJsonAtomic(path, current);
    },
  };
}

function collectIntegrations(dataDir: string): MigrationSource | null {
  const path = join(dataDir, 'integrations.json');
  const parsed = readJsonObject(path);
  if (!parsed) return null;
  const secrets: Record<string, string> = {};
  if (typeof parsed.tavilyApiKey === 'string' && parsed.tavilyApiKey) {
    secrets[SECRET_IDS.tavilyApiKey] = parsed.tavilyApiKey;
  }
  if (typeof parsed.rapidApiKey === 'string' && parsed.rapidApiKey) {
    secrets[SECRET_IDS.rapidApiKey] = parsed.rapidApiKey;
  }
  if (Object.keys(secrets).length === 0) return null;
  return {
    secrets,
    scrub: () => {
      const current = readJsonObject(path);
      if (!current) return;
      delete current.tavilyApiKey;
      delete current.rapidApiKey;
      writeJsonAtomic(path, current);
    },
  };
}

function collectOAuth(dataDir: string): MigrationSource | null {
  const path = join(dataDir, 'oauth-credentials.json');
  const parsed = readJsonObject(path);
  if (
    !parsed ||
    typeof parsed.refresh !== 'string' ||
    typeof parsed.access !== 'string'
  ) {
    return null;
  }
  return {
    secrets: { [SECRET_IDS.copilotOAuth]: JSON.stringify(parsed) },
    scrub: () => writeJsonAtomic(path, {}),
  };
}

export function hasPlaintextCredentials(dataDir: string): boolean {
  return Boolean(
    collectLlm(dataDir) ||
    collectIntegrations(dataDir) ||
    collectOAuth(dataDir),
  );
}

/** Encrypt, read back, verify, and only then remove legacy plaintext fields. */
export async function migratePlaintextCredentials(
  dataDir: string,
  store: EncryptedFileSecretStore,
): Promise<void> {
  const sources = [
    collectLlm(dataDir),
    collectIntegrations(dataDir),
    collectOAuth(dataDir),
  ].filter((source): source is MigrationSource => source !== null);
  if (sources.length === 0) return;

  const updates: Record<string, string> = {};
  for (const source of sources) Object.assign(updates, source.secrets);
  await store.setMany(updates, false);
  for (const id of Object.keys(updates)) {
    if (store.get(id) === null) {
      throw new Error(
        `Encrypted credential migration verification failed for ${id}`,
      );
    }
  }
  for (const source of sources) source.scrub();
}
