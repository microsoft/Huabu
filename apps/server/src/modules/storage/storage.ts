/**
 * Storage composition root.
 *
 * Builds one {@link BlobStore} and one {@link StructuredStore} from a
 * validated {@link StorageProfile} and holds them for the process. This is
 * the only place that maps a backend kind to an adapter.
 *
 * The module-level holder mirrors `workspace.ts`, which keeps the active
 * workspace path in module state set once at boot. Call {@link initStorage}
 * from the server entry point so a bad profile fails at startup with an
 * actionable message.
 *
 * Anything that reaches for storage without that — tests, scripts — builds
 * the adapters on demand. That path is synchronous, so it cannot `await
 * init()`, and it is therefore only legal for backends that have nothing to
 * open; see {@link requiresExplicitInit}. It is not a lazy version of
 * {@link initStorage}, and a connection-holding backend must not be reached
 * through it.
 */

import { DiskBlobStore } from './backends/disk/blob-store.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';

import type { BlobScope, BlobStore } from './ports/blob.js';
import type { StorageHealth } from './ports/common.js';
import type { StructuredStore } from './ports/structured.js';

export interface Storage {
  readonly profile: StorageProfile;
  readonly structured: StructuredStore;
  readonly blobs: BlobStore;
}

function buildBlobStore(profile: StorageProfile): BlobStore {
  switch (profile.blobs.kind) {
    case 'disk':
      return new DiskBlobStore();
    default:
      // Unreachable: validateStorageProfile rejects unimplemented kinds.
      throw new Error(`Unsupported blob backend: ${profile.blobs.kind}`);
  }
}

function buildStructuredStore(profile: StorageProfile): StructuredStore {
  switch (profile.structured.kind) {
    case 'disk':
      return new DiskStructuredStore();
    default:
      throw new Error(
        `Unsupported structured backend: ${profile.structured.kind}`,
      );
  }
}

/** Validate a profile and construct both connections. Does not `init()`. */
export function createStorage(profile: StorageProfile): Storage {
  validateStorageProfile(profile);
  return {
    profile,
    structured: buildStructuredStore(profile),
    blobs: buildBlobStore(profile),
  };
}

// ─── Process-wide holder ────────────────────────────────────────────────────

let current: Storage | null = null;

function ensure(): Storage {
  if (current) return current;

  const profile = parseStorageProfile();
  // Build first, so an unimplemented backend reports that rather than the
  // initialization complaint below.
  const storage = createStorage(profile);
  if (requiresExplicitInit(profile)) {
    throw new StorageProfileError(
      `Storage was used before initStorage(). The ` +
        `"${profile.structured.kind}" / "${profile.blobs.kind}" profile has ` +
        `connections to open, and the on-demand path cannot await init(). ` +
        `Call initStorage() during startup.`,
    );
  }
  current = storage;
  return current;
}

/**
 * Build the storage connections and open them.
 *
 * Called at server boot so an invalid profile surfaces immediately rather
 * than on the first upload.
 */
export async function initStorage(
  profile: StorageProfile = parseStorageProfile(),
): Promise<Storage> {
  const storage = createStorage(profile);
  await Promise.all([storage.structured.init(), storage.blobs.init()]);
  current = storage;
  return storage;
}

export function getStorage(): Storage {
  return ensure();
}

export function getBlobStore(): BlobStore {
  return ensure().blobs;
}

export function getStructuredStore(): StructuredStore {
  return ensure().structured;
}

/** Blob scope for one Space — the only scope kind today. */
export function canvasBlobs(canvasId: string): BlobScope {
  return getBlobStore().scope({ kind: 'canvas', canvasId });
}

export async function storageHealth(): Promise<StorageHealth[]> {
  const storage = ensure();
  return Promise.all([storage.structured.health(), storage.blobs.health()]);
}

/**
 * Swap the active storage, returning a restore function.
 *
 * For tests that need a stub backend. Production code should go through
 * {@link initStorage}.
 */
export function setStorageForTesting(storage: Storage | null): () => void {
  const previous = current;
  current = storage;
  return () => {
    current = previous;
  };
}
