// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Hard cap so a malformed id cannot bloat the vault's key space. */
const MAX_SECRET_ID_LENGTH = 256;

/**
 * Shape of a bridged secret id: a known namespace followed by one to three
 * `:`-separated segments (`llm:image:api-key` has two, the per-provider
 * `llm:provider:<id>:api-key` has three).
 */
const SECRET_ID_SHAPE = /^(llm|integration|oauth)(:[a-z0-9._-]{1,64}){1,3}$/i;

/**
 * Validate a secret id arriving over the utility-process bridge.
 *
 * Deliberately a *structural* check rather than an exact copy of the server's
 * `SECRET_IDS`. The server process already receives every decrypted secret in
 * the `secret:init` snapshot, so enumerating ids here buys no confidentiality;
 * it only keeps junk out of the vault. An exact list bought that marginal
 * hygiene at the price of a recurring outage class — a server-side id the
 * desktop package forgot to mirror is rejected as `Invalid secure credential
 * mutation` and the credential silently never persists (see
 * microsoft/Huabu#40). Matching on shape keeps the hygiene and removes the
 * hand-synced duplication entirely: new server secrets are accepted as long
 * as they follow the established naming scheme.
 */
export function isDesktopSecretId(value: string): boolean {
  return value.length <= MAX_SECRET_ID_LENGTH && SECRET_ID_SHAPE.test(value);
}

export interface SafeStorageCodec {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface EncryptedSecretFile {
  version: 1;
  entries: Record<string, string>;
}

const SECURE_SECRETS_FILENAME = 'secure-secrets.json';

/**
 * Read a JSON object from disk. A missing file is a legitimate empty state
 * (returns null); a present-but-corrupt file is fatal (throws) so callers
 * fail closed instead of silently treating destroyed data as "no data".
 */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Cannot parse corrupted credential file: ${path}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed credential file: ${path}`);
  }
  return value as Record<string, unknown>;
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

/**
 * Load the encrypted secret file. Absent = a fresh empty store; present but
 * corrupt/unsupported = fatal, so we never mistake a damaged vault for an
 * empty one and let a later write overwrite the user's real credentials.
 */
function readEncryptedFile(path: string): EncryptedSecretFile {
  const parsed = readJsonObject(path);
  if (!parsed) return { version: 1, entries: {} };
  if (parsed.version !== 1) {
    throw new Error(`Unsupported secure credential file version: ${path}`);
  }
  const rawEntries = parsed.entries;
  if (
    !rawEntries ||
    typeof rawEntries !== 'object' ||
    Array.isArray(rawEntries)
  ) {
    throw new Error(`Malformed secure credential entries: ${path}`);
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value !== 'string') {
      throw new Error(`Malformed secure credential entry "${key}": ${path}`);
    }
    entries[key] = value;
  }
  return { version: 1, entries };
}

/** OS-protected, encrypted-at-rest secret store owned by Electron main. */
export class DesktopSecureSecretStore {
  private readonly path: string;
  private encrypted: EncryptedSecretFile;
  /** True only once the on-disk vault has been read cleanly. */
  private loaded = false;

  constructor(
    dataDir: string,
    private readonly codec: SafeStorageCodec,
  ) {
    this.path = join(dataDir, SECURE_SECRETS_FILENAME);
    this.encrypted = readEncryptedFile(this.path);
    this.loaded = true;
  }

  /**
   * Defense in depth: never replace the on-disk vault unless we know we hold
   * a clean, complete view of it. A fail-closed read already throws on
   * corruption, but this guard also stops any future regression from
   * overwriting real credentials with a partially-loaded snapshot.
   */
  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        'Refusing to write secure credentials before a clean load',
      );
    }
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
    this.assertLoaded();
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
