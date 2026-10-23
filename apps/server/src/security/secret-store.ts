// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '../data-dir.js';
import {
  ElectronSecretStore,
  isDesktopSecretBridgeEnabled,
} from './desktop-secret-bridge.js';
import {
  EncryptedFileSecretStore,
  parseServerMasterKey,
} from './encrypted-file-secret-store.js';
import { EnvironmentSecretStore } from './environment-secret-store.js';
import { resolveStandaloneMasterKey } from './private-config.js';

import type { SecretStore } from './secret-store-types.js';

const environmentStore = new EnvironmentSecretStore();
let primaryStore: SecretStore | null = null;
let initialized = false;

/** Select and initialize the runtime backend before accepting requests. */
export async function initializeSecretStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (initialized) return;
  await environmentStore.initialize();

  if (isDesktopSecretBridgeEnabled()) {
    primaryStore = new ElectronSecretStore();
    await primaryStore.initialize();
    initialized = true;
    return;
  }

  const dataDir = getDataDir(env);
  const encryptedPath = join(dataDir, 'encrypted-secrets.json');
  const encodedKey = env.HUABU_SECRET_KEY?.trim();
  // Never let a deployment-owned master key reach forked external agents.
  delete env.HUABU_SECRET_KEY;
  const key = encodedKey
    ? parseServerMasterKey(encodedKey)
    : resolveStandaloneMasterKey(existsSync(encryptedPath), env);
  const store = new EncryptedFileSecretStore(dataDir, key);
  await store.initialize();
  primaryStore = store;
  initialized = true;
}

function assertInitialized(): void {
  if (!initialized) {
    throw new Error('Secret store has not been initialized');
  }
}

/** Read UI-persisted credentials first, then deployment-owned environment values. */
export function getSecret(id: string): string | null {
  assertInitialized();
  return primaryStore?.get(id) ?? environmentStore.get(id);
}

/** Read only the writable backend, excluding environment fallbacks. */
export function getPersistedSecret(id: string): string | null {
  assertInitialized();
  return primaryStore?.get(id) ?? null;
}

/** Read saved credentials without creating storage for a new instance. */
export async function readPersistedSecret(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (
    !initialized &&
    !isDesktopSecretBridgeEnabled() &&
    !existsSync(join(getDataDir(env), 'encrypted-secrets.json'))
  ) {
    return null;
  }
  await initializeSecretStore(env);
  return getPersistedSecret(id);
}

/** Write only to the secure primary backend. */
export async function setSecret(
  id: string,
  value: string | null,
): Promise<void> {
  assertInitialized();
  if (!primaryStore) await environmentStore.set(id, value);
  else await primaryStore.set(id, value);
}

/**
 * Write several credentials in one operation. On the encrypted-file backend
 * this is atomic (all-or-nothing); on the desktop bridge it degrades to a
 * sequential apply. Prefer this over multiple {@link setSecret} calls when a
 * single settings update touches more than one secret.
 */
export async function setSecrets(
  updates: Record<string, string | null>,
): Promise<void> {
  assertInitialized();
  if (!primaryStore) {
    for (const [id, value] of Object.entries(updates)) {
      await environmentStore.set(id, value);
    }
    return;
  }
  await primaryStore.setMany(updates);
}

export function getSecretStoreKind(): string {
  assertInitialized();
  return primaryStore?.kind ?? environmentStore.kind;
}

export function isSecretStoreWritable(): boolean {
  assertInitialized();
  return primaryStore?.writable ?? environmentStore.writable;
}
