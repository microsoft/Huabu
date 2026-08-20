// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Product-level storage harness.
 *
 * Mounts a **real** profile onto a temporary Workspace through the production
 * lifecycle — prepared Workspace, opened connections, `ensureWorld()` — rather
 * than swapping in a stub. That distinction is the whole point: a suite
 * written against a stub proves that the application talks to an interface,
 * while this one proves that a *backend* serves the product (proposal
 * §12.6.6).
 *
 * It exists so a product test is written once and run against every profile.
 * Phase 5 adds one entry to {@link PRODUCT_STORAGE_PROFILES} and the same
 * behaviours are covered for SQLite, without a line of the suite changing —
 * which is also the check that the suite never learned a backend's layout.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeStorage, mountStorage } from './storage.js';
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
];

/** Readable name for a profile, for test titles. */
export function describeProfile(profile: StorageProfile): string {
  return `${profile.structured.kind}/${profile.blobs.kind}`;
}

export interface MountedTestStorage {
  readonly profile: StorageProfile;
  readonly storage: Storage;
  /** The temporary Workspace. Only the harness itself should name paths. */
  readonly workspacePath: string;
  close(): Promise<void>;
}

/**
 * Mount `profile` onto a fresh temporary Workspace.
 *
 * Goes through `setWorkspacePath` and {@link mountStorage} rather than
 * reaching for the adapters, so a test exercises the same preparation and
 * bootstrap a running Server does. A backend whose mount is broken fails here,
 * in the harness, instead of surfacing as a confusing product failure later.
 */
export async function mountTestWorkspace(
  profile: StorageProfile,
  prefix = 'huabu-product-',
): Promise<MountedTestStorage> {
  // A profile label reads as `disk/disk`, which is not a directory name.
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, '-');
  const workspacePath = mkdtempSync(path.join(tmpdir(), safePrefix));
  // Prepares and commits the Workspace; the mount below is the second half of
  // the same startup sequence.
  setWorkspacePath(workspacePath);
  const storage = await mountStorage(profile);

  return {
    profile,
    storage,
    workspacePath,
    async close(): Promise<void> {
      await closeStorage();
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
