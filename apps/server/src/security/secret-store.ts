// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ElectronSecretStore,
  isDesktopSecretBridgeEnabled,
} from './desktop-secret-bridge.js';
import {
  CREDENTIALS_RECORD,
  EncryptedSecretStore,
  openCredentialEnvelope,
} from './encrypted-secret-store.js';
import { EnvironmentSecretStore } from './environment-secret-store.js';
import { resolveStandaloneMasterKey } from './private-config.js';
import { masterKeyPrerequisite, readSavedSecret } from './saved-secret.js';
import { SECRET_IDS } from './secret-ids.js';
import { personalSecretId } from '../modules/identity/personal-settings.js';
import { assertImportableShapes } from '../modules/server-record-shapes.js';
// Not the storage barrel: setup loads this module, and only the record
// composition root loads without the rest of the storage graph.
import { initServerRecords } from '../modules/storage/server-records.js';

import type { SecretStore } from './secret-store-types.js';
import type { ServerRecordImportCheck } from '../modules/storage/server-records.js';

const environmentStore = new EnvironmentSecretStore();
let primaryStore: SecretStore | null = null;
let initialized = false;

/**
 * The check the first open of records runs on what it would import, before
 * it upgrades the database: every owner must be able to read its record,
 * and the master key must open the credentials. Opening upgrades the schema,
 * which the earlier version can then no longer open, and the import is the
 * only copy the Server reads from then on. Records already imported are not
 * checked again: the database's copy is the one in use.
 */
function importCheck(
  key: Buffer | null,
  env: NodeJS.ProcessEnv,
): ServerRecordImportCheck {
  return (pending) => {
    assertImportableShapes(pending);
    const legacy = pending.find(
      ({ key: record }) =>
        record.owner === CREDENTIALS_RECORD.owner &&
        record.name === CREDENTIALS_RECORD.name,
    );
    if (legacy)
      openCredentialEnvelope(
        legacy.value,
        key ?? resolveStandaloneMasterKey(true, env),
      );
  };
}

/** Select and initialize the runtime backend before accepting requests. */
export async function initializeSecretStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (initialized) return;
  await environmentStore.initialize();

  if (isDesktopSecretBridgeEnabled()) {
    primaryStore = new ElectronSecretStore();
    await primaryStore.initialize();
    // Credentials live in the desktop's own store, but the other records
    // are opened here all the same, so their import is checked first.
    await initServerRecords(env, { checkImport: assertImportableShapes });
    initialized = true;
    return;
  }

  // Before anything reaches a database.
  let key = masterKeyPrerequisite(env);
  // Never let a deployment-owned master key reach forked external agents.
  delete env.HUABU_SECRET_KEY;
  const records = await initServerRecords(env, {
    checkImport: importCheck(key, env),
  });
  key ??= resolveStandaloneMasterKey(
    (await records.get(CREDENTIALS_RECORD)) !== null,
    env,
  );
  const store = new EncryptedSecretStore(records, key);
  await store.initialize();
  primaryStore = store;
  initialized = true;
}

function assertInitialized(): void {
  if (!initialized) {
    throw new Error('Secret store has not been initialized');
  }
}

/**
 * The deployment's own credentials, never anyone's personal ones: a member
 * running in their personal settings neither reads nor writes these as theirs.
 */
const DEPLOYMENT_SECRET_IDS: ReadonlySet<string> = new Set([
  SECRET_IDS.agentletConnectionToken,
  SECRET_IDS.managedConnectionToken,
  SECRET_IDS.remoteAccessPassword,
]);

/** Where `id` is kept for this call: a member's own, or the deployment's. */
function scopedId(id: string): { id: string; personal: boolean } {
  if (DEPLOYMENT_SECRET_IDS.has(id)) return { id, personal: false };
  const personal = personalSecretId(id);
  return { id: personal, personal: personal !== id };
}

/**
 * Read UI-persisted credentials first, then deployment-owned environment
 * values. A member's personal credentials have no environment fallback: the
 * deployment's environment is the operator's.
 */
export function getSecret(id: string): string | null {
  assertInitialized();
  const scoped = scopedId(id);
  if (scoped.personal) return primaryStore?.get(scoped.id) ?? null;
  return primaryStore?.get(id) ?? environmentStore.get(id);
}

/** Read only the writable backend, excluding environment fallbacks. */
export function getPersistedSecret(id: string): string | null {
  assertInitialized();
  return primaryStore?.get(scopedId(id).id) ?? null;
}

/**
 * Read a saved credential without changing storage: nothing is created for
 * a new instance, and a database an earlier version left is neither upgraded
 * nor imported into, so `setup` can ask before the operator confirms
 * anything and a cancelled run leaves storage as it found it. Once the
 * secret store is initialized, this reads that store.
 */
export async function readPersistedSecret(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (initialized || isDesktopSecretBridgeEnabled()) {
    await initializeSecretStore(env);
    return getPersistedSecret(id);
  }
  return readSavedSecret(scopedId(id).id, env);
}

/** Write only to the secure primary backend. */
export async function setSecret(
  id: string,
  value: string | null,
): Promise<void> {
  assertInitialized();
  const scoped = scopedId(id);
  if (!primaryStore) {
    if (scoped.personal)
      throw new Error('Personal credentials need a writable secret store');
    await environmentStore.set(id, value);
  } else await primaryStore.set(scoped.id, value);
}

/**
 * Write several credentials in one operation. On the encrypted backend
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
      await setSecret(id, value);
    }
    return;
  }
  await primaryStore.setMany(
    Object.fromEntries(
      Object.entries(updates).map(([id, value]) => [scopedId(id).id, value]),
    ),
  );
}

export function getSecretStoreKind(): string {
  assertInitialized();
  return primaryStore?.kind ?? environmentStore.kind;
}

export function isSecretStoreWritable(): boolean {
  assertInitialized();
  return primaryStore?.writable ?? environmentStore.writable;
}
