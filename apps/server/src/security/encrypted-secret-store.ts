// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import type { SecretStore } from './secret-store-types.js';
import type {
  ServerRecordKey,
  ServerRecords,
} from '../modules/storage/index.js';

interface EncryptedEntry {
  iv: string;
  ciphertext: string;
  tag: string;
}

/** The persisted envelope; one record holds every credential. */
interface EncryptedSecretFile {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  entries: Record<string, EncryptedEntry>;
}

/** The server record holding the envelope (`encrypted-secrets.json` on Disk). */
export const CREDENTIALS_RECORD: ServerRecordKey = Object.freeze({
  owner: null,
  name: 'credentials',
});
const ALGORITHM = 'aes-256-gcm';
const AAD_PREFIX = 'huabu-secret-v1:';

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

function parseEncryptedFile(value: unknown): EncryptedSecretFile {
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

/**
 * AES-256-GCM credentials for a standalone Server, kept as one envelope in the
 * deployment's `credentials` server record — a file on Disk, a row on SQLite
 * and PostgreSQL. Each credential is encrypted separately with a random IV
 * and its id as additional authenticated data; the key never enters the
 * record, only its fingerprint.
 */
export class EncryptedSecretStore implements SecretStore {
  readonly writable = true;
  readonly kind = 'encrypted';

  private readonly keyId: string;
  private secrets = new Map<string, string>();

  constructor(
    private readonly records: ServerRecords,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error('EncryptedSecretStore requires a 32-byte master key');
    }
    this.keyId = createHash('sha256')
      .update(masterKey)
      .digest('hex')
      .slice(0, 16);
  }

  async initialize(): Promise<void> {
    const stored = this.records.get(CREDENTIALS_RECORD);
    if (stored === null) return;
    this.secrets = this.decryptAll(this.parseOwn(stored));
  }

  get(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  async set(id: string, value: string | null): Promise<void> {
    await this.setMany({ [id]: value }, true);
  }

  /**
   * Persist several values in one record replacement, then read the
   * acknowledged record back, authenticate and decrypt every entry, and only
   * then publish the new values.
   */
  async setMany(
    updates: Record<string, string | null>,
    overwrite = true,
  ): Promise<void> {
    let next = new Map<string, string>();
    await this.records.update(CREDENTIALS_RECORD, (current) => {
      next =
        current === null ? new Map() : this.decryptAll(this.parseOwn(current));
      for (const [id, value] of Object.entries(updates)) {
        if (!overwrite && next.has(id)) continue;
        if (value === null) next.delete(id);
        else next.set(id, value);
      }
      return this.encryptAll(next);
    });

    const verifiedSecrets = this.decryptAll(
      this.parseOwn(this.records.get(CREDENTIALS_RECORD)),
    );
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

  /** Parse an envelope and refuse one written under a different key. */
  private parseOwn(value: unknown): EncryptedSecretFile {
    const persisted = parseEncryptedFile(value);
    if (persisted.keyId !== this.keyId) {
      throw new Error(
        'HUABU_SECRET_KEY does not match the existing encrypted credentials',
      );
    }
    return persisted;
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
