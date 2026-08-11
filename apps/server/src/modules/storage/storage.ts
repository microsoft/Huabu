// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import path from 'node:path';

import { withSpaceDirHandlesReleased } from '../workspace/disk/space-dir-handles.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspacePath,
} from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
import {
  withSpaceDeleteAdmission,
  withSpacePutAdmission,
} from './backends/disk/legacy/space-lifecycle-admission.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';

import type {
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobStore,
} from './ports/blob.js';
import type { StorageHealth } from './ports/common.js';
import type { StructuredStore } from './ports/structured.js';
import type {
  SpaceCreateInput,
  SpaceCreateResult,
  SpaceDeleteResult,
} from './ports/structured.js';
import type { Readable } from 'node:stream';

function activeWorkspacePath(): string {
  return path.resolve(getWorkspacePath());
}

function assertActiveWorkspace(workspacePath: string, canvasId: string): void {
  if (activeWorkspacePath() !== workspacePath) {
    throw new Error(
      `Blob scope for Space "${canvasId}" belongs to an inactive workspace. ` +
        `Resolve a fresh scope after workspace activation.`,
    );
  }
}

/**
 * Release a rejected streaming body that storage never fully consumed.
 *
 * Multipart parsers cannot finish the request while a file part stays
 * paused. Resume it to discard the remaining bytes; Buffer callers retain
 * their existing value semantics and need no disposal.
 */
function drainRejectedBody(body: Readable | Buffer): void {
  if (Buffer.isBuffer(body) || body.destroyed || body.readableEnded) return;

  const ignoreError = (): void => {};
  body.once('error', ignoreError);
  body.once('end', () => body.off('error', ignoreError));
  body.resume();
}

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

/**
 * Create one structured Space while pinning the active Workspace.
 *
 * Creation takes the same exclusive per-Space admission used by deletion so
 * a same-id create/delete pair cannot cross. The structured backend owns the
 * catalogue + v0-record transaction and returns the effective de-duplicated
 * title.
 */
export async function createSpace(
  input: SpaceCreateInput,
): Promise<SpaceCreateResult> {
  const storage = ensure();
  const workspaceLease = acquireWorkspaceOperationLease();
  const workspacePath = path.resolve(workspaceLease.workspacePath);
  try {
    return await withSpaceDeleteAdmission(
      workspacePath,
      input.canvasId,
      async () => {
        assertActiveWorkspace(workspacePath, input.canvasId);
        return storage.structured.lifecycle().create(input);
      },
    );
  } finally {
    workspaceLease.release();
  }
}

/**
 * Delete one Space across the independent blob and structured stores.
 *
 * The structured lifecycle invokes `beforeRemove` only after refusing World
 * and while the record is still present. A blob failure therefore leaves the
 * structured member intact and the whole operation safely retryable. Disk
 * directory handles are released across both the sweep and quarantine move.
 */
export async function deleteSpace(
  canvasId: string,
): Promise<SpaceDeleteResult> {
  const storage = ensure();
  const workspaceLease = acquireWorkspaceOperationLease();
  const workspacePath = path.resolve(workspaceLease.workspacePath);
  try {
    return await withSpaceDeleteAdmission(workspacePath, canvasId, async () =>
      withSpaceDirHandlesReleased(canvasId, async () => {
        assertActiveWorkspace(workspacePath, canvasId);
        const blobs = storage.blobs.scope({ kind: 'canvas', canvasId });
        return storage.structured.lifecycle().delete({
          canvasId,
          beforeRemove: async () => {
            assertActiveWorkspace(workspacePath, canvasId);
            await blobs.deleteAll();
            assertActiveWorkspace(workspacePath, canvasId);
          },
        });
      }),
    );
  } finally {
    workspaceLease.release();
  }
}

/**
 * Blob scope for one Space — the only scope kind today.
 *
 * The raw BlobStore intentionally knows nothing about structured lifecycle,
 * so composition owns the one cross-store invariant: bytes may only be added
 * to a Space whose record exists. Reads and `deleteAll()` stay available for
 * cleanup/recovery when a record has already gone missing.
 */
export function canvasBlobs(canvasId: string): BlobScope {
  const storage = ensure();
  const workspacePath = activeWorkspacePath();
  const delegate = storage.blobs.scope({ kind: 'canvas', canvasId });

  async function requireSpace(): Promise<void> {
    const record = await storage.structured.space(canvasId).record.read();
    if (!record) {
      throw new Error(`Cannot write blobs for missing Space "${canvasId}"`);
    }
  }

  return {
    async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
      try {
        return await withSpacePutAdmission(
          workspacePath,
          canvasId,
          async () => {
            assertActiveWorkspace(workspacePath, canvasId);
            await requireSpace();
            assertActiveWorkspace(workspacePath, canvasId);
            return delegate.put(name, body);
          },
        );
      } catch (error) {
        drainRejectedBody(body);
        throw error;
      }
    },
    head(name: string): Promise<BlobInfo | null> {
      return delegate.head(name);
    },
    open(name: string, range?: BlobRange): Promise<BlobRead | null> {
      return delegate.open(name, range);
    },
    read(name: string): Promise<Buffer | null> {
      return delegate.read(name);
    },
    hasMany(names: readonly string[]): Promise<ReadonlySet<string>> {
      return delegate.hasMany(names);
    },
    list(): Promise<BlobInfo[]> {
      return delegate.list();
    },
    materialize(name: string): Promise<BlobLease | null> {
      return delegate.materialize(name);
    },
    deleteAll(): Promise<void> {
      return delegate.deleteAll();
    },
  };
}

/**
 * Run Space deletion exclusively against blob puts admitted for the same
 * workspace and Space. Kept here because it coordinates two otherwise
 * independent storage ports; the compatibility lifecycle facade supplies the
 * actual sweep and structured destroy operation.
 */
export function withCanvasDeletionAdmission<T>(
  canvasId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const workspacePath = activeWorkspacePath();
  return withSpaceDeleteAdmission(workspacePath, canvasId, async () => {
    assertActiveWorkspace(workspacePath, canvasId);
    return operation();
  });
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
