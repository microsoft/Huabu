// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Mount a real storage profile for a product test.
 *
 * The reusable suites under `ports/contracts/` prove an adapter honours a
 * contract in isolation. They cannot prove the thing Phase 5 actually needs
 * to know: that the *application* still works when the backend changes. That
 * question is only answerable by running product behaviour — real Canvas
 * services, real serializers, real materialization — against a mounted
 * profile, and it is only worth answering once there is more than one profile
 * to mount.
 *
 * So this is deliberately not a stub factory. `setStorageForTesting()` swaps
 * in a fake and is the right tool for isolating a caller from storage; this
 * one goes through the production lifecycle — a prepared Workspace, staged
 * connections, `ensureWorld()`, the atomic mount swap — so what a test
 * exercises is what the server does. A test written against it is
 * backend-agnostic by construction: adding a profile to
 * {@link PRODUCT_STORAGE_PROFILES} runs every such test against it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type StorageProfile } from './profile.js';
import {
  closeStorage,
  getStorage,
  stageStorageForWorkspace,
  type Storage,
} from './storage.js';
import { setWorkspacePath } from '../workspace.js';

export interface MountedTestStorage {
  readonly profile: StorageProfile;
  readonly workspacePath: string;
  readonly storage: Storage;
  /** Close the connections and remove the temporary Workspace. */
  unmount(): Promise<void>;
}

/**
 * Every profile product behaviour should hold for.
 *
 * One entry today. It is a list rather than a constant because that is the
 * whole point: the second structured adapter joins it, and every test written
 * against {@link mountTestStorage} starts covering it without being touched.
 */
export const PRODUCT_STORAGE_PROFILES: readonly StorageProfile[] = [
  {
    structured: { kind: 'disk' },
    blobs: { kind: 'disk' },
  },
];

/** A short, stable label for a profile — useful as a test name. */
export function describeProfile(profile: StorageProfile): string {
  return `${profile.structured.kind}/${profile.blobs.kind}`;
}

/**
 * Prepare a temporary Workspace and mount `profile` onto it.
 *
 * The Workspace is prepared through `setWorkspacePath`, so boot migrations
 * and the World bootstrap run exactly as they do at startup.
 */
export async function mountTestStorage(
  options: {
    readonly profile?: StorageProfile;
    readonly prefix?: string;
  } = {},
): Promise<MountedTestStorage> {
  const profile = options.profile ?? PRODUCT_STORAGE_PROFILES[0];
  const workspacePath = mkdtempSync(
    path.join(tmpdir(), options.prefix ?? 'huabu-product-'),
  );
  setWorkspacePath(workspacePath);
  const staged = await stageStorageForWorkspace(workspacePath, profile);
  await staged.activate();

  let unmounted = false;
  return {
    profile,
    workspacePath,
    get storage(): Storage {
      return getStorage();
    },
    async unmount(): Promise<void> {
      if (unmounted) return;
      unmounted = true;
      await closeStorage();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}
