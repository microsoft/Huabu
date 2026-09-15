// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Product-level storage harness.
 *
 * Opens a **real** profile against a temporary Workspace through the
 * production lifecycle — prepared Workspace, opened connections,
 * `ensureWorld()` — rather than swapping in a stub. That distinction is the
 * whole point: a suite written against a stub proves that the application
 * talks to an interface, while this one proves that a *backend* serves the
 * product (proposal §12.8).
 *
 * It exists so a product test is written once and run against every profile.
 * Phase 5 adds one entry to {@link PRODUCT_STORAGE_PROFILES} and the same
 * behaviours are covered for SQLite, without a line of the suite changing —
 * which is also the check that the suite never learned a backend's layout.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeStorage, initStorage } from './storage.js';
import { setWorkspacePath } from '../workspace.js';

import type { StorageProfile } from './profile.js';
import type { Storage } from './storage.js';

/**
 * Every profile the product suite must pass against.
 *
 * A backend joins this list when it claims to serve the product, not when its
 * adapter first compiles — an adapter may exist for isolated testing before
 * its profile is selectable.
 */
export const PRODUCT_STORAGE_PROFILES: readonly StorageProfile[] = [
  { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
  { structured: { kind: 'sqlite' }, blobs: { kind: 'disk' } },
];

/** Readable name for a profile, for test titles. */
export function describeProfile(profile: StorageProfile): string {
  return `${profile.structured.kind}/${profile.blobs.kind}`;
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

export interface MountedTestStorage {
  readonly profile: StorageProfile;
  readonly storage: Storage;
  /**
   * The temporary directory this mount owns.
   *
   * For a Disk profile it is the Workspace itself; for a profile that keeps
   * Workspaces in a database it is only where the harness put that database
   * and the Space byte root. Either way it is the harness's own business — a
   * case that reads it has stopped being evidence of anything portable.
   */
  readonly workspacePath: string;
  /**
   * Close the connections and open them again on the same durable state.
   *
   * What a restart actually is, for a suite that needs to prove something
   * survives one. Returns the fresh {@link Storage}; the mount's own
   * `storage` field still refers to the closed one, so a caller uses the
   * value this returns.
   */
  reopen(): Promise<Storage>;
  close(): Promise<void>;
}

/**
 * Open `profile` against a fresh temporary Workspace.
 *
 * Goes through `setWorkspacePath` and {@link initStorage} rather than
 * reaching for the adapters, so a test exercises the same preparation,
 * connection, and World bootstrap a running Server does. A backend whose
 * startup is broken fails here, in the harness, instead of surfacing as a
 * confusing product failure later.
 */
export async function mountTestWorkspace(
  profile: StorageProfile,
  prefix = 'huabu-product-',
): Promise<MountedTestStorage> {
  // A profile label reads as `disk/disk`, which is not a directory name.
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, '-');
  const workspacePath = mkdtempSync(path.join(tmpdir(), safePrefix));
  const previousSqlitePath = process.env['HUABU_SQLITE_PATH'];
  const previousBlobRoot = process.env['HUABU_BLOB_ROOT'];

  if (profile.structured.kind === 'disk') {
    // Prepares and commits the Workspace, exactly as a synchronous activation
    // does. Workspace selection precedes storage here for the same reason it
    // does at boot: the backend is process-wide and the Workspace is the
    // namespace selected inside it.
    setWorkspacePath(workspacePath);
  } else {
    // No Workspace folder to pick. The Workspace is a row the backend creates
    // on first start, and `initStorage` activates it — which is exactly the
    // behaviour that lets this profile run without one. The temp directory
    // only gives this mount its own database file and its own byte root, so
    // parallel suites do not share either.
    process.env['HUABU_SQLITE_PATH'] = path.join(workspacePath, 'huabu.sqlite');
    process.env['HUABU_BLOB_ROOT'] = path.join(workspacePath, 'blobs');
  }

  const storage = await initStorage(profile);
  // A namespace nobody has opened before has no World, and a Workspace
  // without one has no home view. Every backend meets that state once.
  await storage.structured.spaces().ensureWorld();

  return {
    profile,
    storage,
    workspacePath,
    async reopen(): Promise<Storage> {
      await closeStorage();
      if (profile.structured.kind === 'disk') setWorkspacePath(workspacePath);
      const reopened = await initStorage(profile);
      await reopened.structured.spaces().ensureWorld();
      return reopened;
    },
    async close(): Promise<void> {
      await closeStorage();
      restoreEnv('HUABU_SQLITE_PATH', previousSqlitePath);
      restoreEnv('HUABU_BLOB_ROOT', previousBlobRoot);
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/**
 * Run `body` once per product profile.
 *
 * The suite names the profile only in its title. Anything a case needs to
 * know about the backend it is running against would be a leak.
 */
export function forEachProductProfile(
  body: (profile: StorageProfile, label: string) => void,
): void {
  for (const profile of PRODUCT_STORAGE_PROFILES) {
    body(profile, describeProfile(profile));
  }
}
