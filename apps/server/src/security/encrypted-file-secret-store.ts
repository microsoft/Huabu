// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
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

import type { SecretStore } from './secret-store-types.js';

interface EncryptedEntry {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface EncryptedSecretFile {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  entries: Record<string, EncryptedEntry>;
}

const FILE_NAME = 'encrypted-secrets.json';
const ALGORITHM = 'aes-256-gcm';
const AAD_PREFIX = 'huabu-secret-v1:';

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

function parseEntry(value: unknown, id: string): EncryptedEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid encrypted credential entry: ${id}`);
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.iv !== 'string' ||
    typeof entry.ciphertext !== 'string' ||
    typeof entry.tag !== 'string'
  ) {
    throw new Error(`Invalid encrypted credential entry: ${id}`);
  }
  return {
    iv: entry.iv,
    ciphertext: entry.ciphertext,
    tag: entry.tag,
  };
}

function parseEncryptedFile(raw: string): EncryptedSecretFile {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid encrypted credential file');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.algorithm !== ALGORITHM ||
    typeof record.keyId !== 'string' ||
    !record.entries ||
    typeof record.entries !== 'object' ||
    Array.isArray(record.entries)
  ) {
    throw new Error('Unsupported encrypted credential file format');
  }
  const entries: Record<string, EncryptedEntry> = {};
  for (const [id, entry] of Object.entries(record.entries)) {
    entries[id] = parseEntry(entry, id);
  }
  return {
    version: 1,
    algorithm: ALGORITHM,
    keyId: record.keyId,
    entries,
  };
}

/** Parse a Base64-encoded, exactly 32-byte AES master key. */
export function parseServerMasterKey(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('HUABU_SECRET_KEY must be valid Base64');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32 || key.toString('base64') !== normalized) {
    throw new Error(
      'HUABU_SECRET_KEY must be the Base64 encoding of exactly 32 random bytes',
    );
  }
  return key;
}

/** AES-256-GCM encrypted file backend for a standalone single-user server. */
export class EncryptedFileSecretStore implements SecretStore {
  readonly writable = true;
  readonly kind = 'encrypted-file';
  readonly path: string;

  private readonly keyId: string;
  private secrets = new Map<string, string>();

  constructor(
    dataDir: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error('EncryptedFileSecretStore requires a 32-byte master key');
    }
    this.path = join(dataDir, FILE_NAME);
    this.keyId = createHash('sha256')
      .update(masterKey)
      .digest('hex')
      .slice(0, 16);
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.path)) return;
    const persisted = parseEncryptedFile(readFileSync(this.path, 'utf-8'));
    if (persisted.keyId !== this.keyId) {
      throw new Error(
        'HUABU_SECRET_KEY does not match the existing encrypted credential file',
      );
    }
    this.secrets = this.decryptAll(persisted);
  }

  get(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  async set(id: string, value: string | null): Promise<void> {
    await this.setMany({ [id]: value }, true);
  }

  /** Persist several values in one authenticated, atomic file replacement. */
  async setMany(
    updates: Record<string, string | null>,
    overwrite = true,
  ): Promise<void> {
    const next = new Map(this.secrets);
    for (const [id, value] of Object.entries(updates)) {
      if (!overwrite && next.has(id)) continue;
      if (value === null) next.delete(id);
      else next.set(id, value);
    }
    const persisted = this.encryptAll(next);
    writeJsonAtomic(this.path, persisted);

    const verified = parseEncryptedFile(readFileSync(this.path, 'utf-8'));
    const verifiedSecrets = this.decryptAll(verified);
    for (const [id, value] of next) {
      if (verifiedSecrets.get(id) !== value) {
        throw new Error(`Encrypted credential verification failed for ${id}`);
      }
    }
    if (verifiedSecrets.size !== next.size) {
      throw new Error(
        'Encrypted credential verification found unexpected entries',
      );
    }
    this.secrets = verifiedSecrets;
  }

  private encryptAll(secrets: Map<string, string>): EncryptedSecretFile {
    const entries: Record<string, EncryptedEntry> = {};
    for (const [id, value] of secrets) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
      cipher.setAAD(Buffer.from(`${AAD_PREFIX}${id}`, 'utf-8'));
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf-8'),
        cipher.final(),
      ]);
      entries[id] = {
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    }
    return {
      version: 1,
      algorithm: ALGORITHM,
      keyId: this.keyId,
      entries,
    };
  }

  private decryptAll(file: EncryptedSecretFile): Map<string, string> {
    const result = new Map<string, string>();
    for (const [id, entry] of Object.entries(file.entries)) {
      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          this.masterKey,
          Buffer.from(entry.iv, 'base64'),
        );
        decipher.setAAD(Buffer.from(`${AAD_PREFIX}${id}`, 'utf-8'));
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(entry.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf-8');
        result.set(id, plaintext);
      } catch {
        throw new Error(`Failed to decrypt credential ${id}`);
      }
    }
    return result;
  }
}
