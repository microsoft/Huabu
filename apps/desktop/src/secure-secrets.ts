import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DESKTOP_SECRET_IDS = {
  imageApiKey: 'llm:image:api-key',
  tavilyApiKey: 'integration:tavily:api-key',
  rapidApiKey: 'integration:rapidapi:api-key',
  copilotOAuth: 'oauth:github-copilot:credentials',
} as const;

export function desktopLlmProviderApiKeySecretId(provider: string): string {
  return `llm:provider:${provider}:api-key`;
}

export function isDesktopSecretId(value: string): boolean {
  return (
    Object.values(DESKTOP_SECRET_IDS).includes(
      value as (typeof DESKTOP_SECRET_IDS)[keyof typeof DESKTOP_SECRET_IDS],
    ) || /^llm:provider:[a-z0-9._-]+:api-key$/i.test(value)
  );
}

export interface SafeStorageCodec {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface EncryptedSecretFile {
  version: 1;
  entries: Record<string, string>;
}

interface PlaintextMigration {
  secrets: Record<string, string>;
  scrub: () => void;
}

const SECURE_SECRETS_FILENAME = 'secure-secrets.json';

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8');
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Best effort on platforms that support POSIX modes.
  }
  renameSync(temporary, path);
}

function readEncryptedFile(path: string): EncryptedSecretFile {
  const parsed = readJsonObject(path);
  if (!parsed || parsed.version !== 1) return { version: 1, entries: {} };
  const rawEntries = parsed.entries;
  if (
    !rawEntries ||
    typeof rawEntries !== 'object' ||
    Array.isArray(rawEntries)
  ) {
    return { version: 1, entries: {} };
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value === 'string') entries[key] = value;
  }
  return { version: 1, entries };
}

function collectLlmMigration(dataDir: string): PlaintextMigration | null {
  const path = join(dataDir, 'llm-config.json');
  const parsed = readJsonObject(path);
  if (!parsed) return null;

  const secrets: Record<string, string> = {};
  const providers = parsed.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [provider, rawEntry] of Object.entries(providers)) {
      if (
        !rawEntry ||
        typeof rawEntry !== 'object' ||
        Array.isArray(rawEntry)
      ) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      if (typeof entry.apiKey === 'string' && entry.apiKey) {
        secrets[desktopLlmProviderApiKeySecretId(provider)] = entry.apiKey;
        if (
          provider === 'azure-openai' &&
          (typeof entry.imageModel === 'string' ||
            typeof entry.imageQuality === 'string')
        ) {
          secrets[DESKTOP_SECRET_IDS.imageApiKey] = entry.apiKey;
        }
      }
    }
  }
  const imageConfig = parsed.imageConfig;
  if (
    imageConfig &&
    typeof imageConfig === 'object' &&
    !Array.isArray(imageConfig) &&
    typeof (imageConfig as Record<string, unknown>).apiKey === 'string'
  ) {
    const apiKey = (imageConfig as Record<string, unknown>).apiKey as string;
    if (apiKey) secrets[DESKTOP_SECRET_IDS.imageApiKey] = apiKey;
  }
  // Pre-map legacy shape, before the server's lazy migration has run.
  if (
    typeof parsed.provider === 'string' &&
    typeof parsed.apiKey === 'string' &&
    parsed.apiKey
  ) {
    secrets[desktopLlmProviderApiKeySecretId(parsed.provider)] = parsed.apiKey;
    if (
      typeof parsed.imageModel === 'string' ||
      typeof parsed.imageQuality === 'string'
    ) {
      secrets[DESKTOP_SECRET_IDS.imageApiKey] = parsed.apiKey;
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
        for (const rawEntry of Object.values(currentProviders)) {
          if (
            rawEntry &&
            typeof rawEntry === 'object' &&
            !Array.isArray(rawEntry)
          ) {
            delete (rawEntry as Record<string, unknown>).apiKey;
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

function collectIntegrationsMigration(
  dataDir: string,
): PlaintextMigration | null {
  const path = join(dataDir, 'integrations.json');
  const parsed = readJsonObject(path);
  if (!parsed) return null;
  const secrets: Record<string, string> = {};
  if (typeof parsed.tavilyApiKey === 'string' && parsed.tavilyApiKey) {
    secrets[DESKTOP_SECRET_IDS.tavilyApiKey] = parsed.tavilyApiKey;
  }
  if (typeof parsed.rapidApiKey === 'string' && parsed.rapidApiKey) {
    secrets[DESKTOP_SECRET_IDS.rapidApiKey] = parsed.rapidApiKey;
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

function collectOAuthMigration(dataDir: string): PlaintextMigration | null {
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
    secrets: { [DESKTOP_SECRET_IDS.copilotOAuth]: JSON.stringify(parsed) },
    scrub: () => writeJsonAtomic(path, {}),
  };
}

/** OS-protected, encrypted-at-rest secret store owned by Electron main. */
export class DesktopSecureSecretStore {
  private readonly path: string;
  private encrypted: EncryptedSecretFile;

  constructor(
    private readonly dataDir: string,
    private readonly codec: SafeStorageCodec,
  ) {
    this.path = join(dataDir, SECURE_SECRETS_FILENAME);
    this.encrypted = readEncryptedFile(this.path);
  }

  /** Encrypt legacy plaintext values first, verify them, then scrub source JSON. */
  migratePlaintextFiles(): void {
    const migrations = [
      collectLlmMigration(this.dataDir),
      collectIntegrationsMigration(this.dataDir),
      collectOAuthMigration(this.dataDir),
    ].filter((item): item is PlaintextMigration => item !== null);
    if (migrations.length === 0) return;

    const nextEntries = { ...this.encrypted.entries };
    const expected: Record<string, string> = {};
    for (const migration of migrations) {
      for (const [key, value] of Object.entries(migration.secrets)) {
        // Existing encrypted values win over stale plaintext left by an
        // interrupted older migration.
        if (!(key in nextEntries)) {
          nextEntries[key] = this.codec.encryptString(value).toString('base64');
        }
        const expectedValue =
          key in this.encrypted.entries ? this.decrypt(key) : value;
        if (expectedValue === null) {
          throw new Error(`Existing secure credential is unreadable: ${key}`);
        }
        expected[key] = expectedValue;
      }
    }

    const next: EncryptedSecretFile = { version: 1, entries: nextEntries };
    writeJsonAtomic(this.path, next);
    this.encrypted = readEncryptedFile(this.path);
    for (const [key, value] of Object.entries(expected)) {
      if (this.decrypt(key) !== value) {
        throw new Error(
          `Secure credential migration verification failed for ${key}`,
        );
      }
    }
    for (const migration of migrations) migration.scrub();
  }

  snapshot(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(this.encrypted.entries)) {
      const value = this.decrypt(key);
      if (value !== null) result[key] = value;
    }
    return result;
  }

  set(key: string, value: string | null): void {
    const entries = { ...this.encrypted.entries };
    if (value === null) {
      delete entries[key];
    } else {
      const encrypted = this.codec.encryptString(value);
      if (this.codec.decryptString(encrypted) !== value) {
        throw new Error('Secure credential encryption verification failed');
      }
      entries[key] = encrypted.toString('base64');
    }
    const next: EncryptedSecretFile = { version: 1, entries };
    writeJsonAtomic(this.path, next);
    this.encrypted = next;
  }

  private decrypt(key: string): string | null {
    const encoded = this.encrypted.entries[key];
    if (!encoded) return null;
    return this.codec.decryptString(Buffer.from(encoded, 'base64'));
  }
}
