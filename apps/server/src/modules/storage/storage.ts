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

import {
  acquireWorkspaceOperationLease,
  getWorkspacePath,
  isWorkspaceConfigured,
} from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
import { AddressedSpaceMaterialization } from './backends/disk/materialization-addressed.js';
import { TitledSpaceMaterialization } from './backends/disk/materialization-titled.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import {
  materializationFor,
  type SpaceMaterialization,
} from './materialization.js';
import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';
import { withSpacePutAdmission } from './space-lifecycle-admission.js';
import { getLogger } from '../../utils/logger.js';

import type {
  BlobInfo,
  BlobLease,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobStore,
} from './ports/blob.js';
import type { StorageHealth } from './ports/common.js';
import type {
  SpaceCreateResult,
  SpaceDeleteFinishResult,
  StructuredStore,
} from './ports/structured.js';
import type { Readable } from 'node:stream';

const log = getLogger('storage');

/**
 * Outcome of the cross-store Space deletion this module composes.
 *
 * Derived from the two port results it is assembled out of — the structured
 * fence's refusal plus whatever the terminal `finish()` reports — rather than
 * restated by hand. It is not a port type: no repository returns it.
 */
export type SpaceDeleteOutcome =
  | SpaceDeleteFinishResult
  | { readonly ok: false; readonly reason: 'world-forbidden' };

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
  readonly workspacePath: string;
  readonly structured: StructuredStore;
  readonly blobs: BlobStore;
  readonly materialization: SpaceMaterialization;
}

/**
 * Select the placement policy the structured backend forces.
 *
 * Not read from the profile: materialization is not a configuration axis, so
 * there is nothing for a deployment to have chosen. See `materialization.ts`.
 */
function buildMaterialization(
  profile: StorageProfile,
  workspacePath: string,
): SpaceMaterialization {
  const kind = materializationFor(profile.structured.kind);
  switch (kind) {
    case 'titled':
      return new TitledSpaceMaterialization(workspacePath);
    case 'addressed':
      return new AddressedSpaceMaterialization(workspacePath);
  }
}

function buildBlobStore(
  profile: StorageProfile,
  materialization: SpaceMaterialization,
): BlobStore {
  switch (profile.blobs.kind) {
    case 'disk':
      return new DiskBlobStore((canvasId) =>
        materialization.space(canvasId).directory(),
      );
    default:
      // Unreachable: validateStorageProfile rejects unimplemented kinds.
      throw new Error(`Unsupported blob backend: ${profile.blobs.kind}`);
  }
}

function buildStructuredStore(
  profile: StorageProfile,
  workspacePath: string,
): StructuredStore {
  switch (profile.structured.kind) {
    case 'disk':
      return new DiskStructuredStore(workspacePath);
    default:
      throw new Error(
        `Unsupported structured backend: ${profile.structured.kind}`,
      );
  }
}

/** Validate a profile and construct the Workspace-bound connections. */
export function createStorage(
  profile: StorageProfile,
  workspacePath: string = getWorkspacePath(),
): Storage {
  validateStorageProfile(profile);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const materialization = buildMaterialization(profile, resolvedWorkspacePath);
  return {
    profile,
    workspacePath: resolvedWorkspacePath,
    structured: buildStructuredStore(profile, resolvedWorkspacePath),
    blobs: buildBlobStore(profile, materialization),
    materialization,
  };
}

// ─── Process-wide holder ────────────────────────────────────────────────────

let current: Storage | null = null;
let configuredProfile: StorageProfile | null = null;
let spaceCreateTail: Promise<void> = Promise.resolve();

export interface StorageRuntime {
  readonly profile: StorageProfile;
  readonly mounted: boolean;
  readonly workspacePath: string | null;
}

export interface StagedStorageMount {
  readonly storage: Storage;
  activate(): Promise<void>;
  abort(): Promise<void>;
}

function defaultSpaceTitle(
  existing: readonly { readonly title: string | null }[],
): string {
  const base = 'Untitled';
  const titles = new Set(existing.map((space) => space.title));
  if (!titles.has(base)) return base;

  let suffix = 1;
  while (titles.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

function serializeSpaceCreate<T>(operation: () => Promise<T>): Promise<T> {
  const result = spaceCreateTail.catch(() => undefined).then(operation);
  spaceCreateTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function ensure(): Storage {
  const workspacePath = activeWorkspacePath();
  if (current?.workspacePath === workspacePath) return current;

  const profile =
    current?.profile ?? configuredProfile ?? parseStorageProfile();
  // Build first, so an unimplemented backend reports that rather than the
  // initialization complaint below.
  const storage = createStorage(profile, workspacePath);
  if (requiresExplicitInit(profile)) {
    throw new StorageProfileError(
      `Storage was used before initStorage(). The ` +
        `"${profile.structured.kind}" / "${profile.blobs.kind}" profile has ` +
        `connections to open, and the on-demand path cannot await init(). ` +
        `Call initStorage() during startup.`,
    );
  }
  // The synchronous free-mode compatibility path can still commit a new
  // Workspace directly. Disk connections are inert, so rebuilding their
  // Workspace-bound handles here preserves that path without letting a
  // retained handle cross namespaces. Backends that require async startup
  // are rejected above and must use the staged activation lifecycle.
  current = storage;
  return current;
}

async function closeConnections(storage: Storage): Promise<void> {
  await Promise.all([
    storage.structured.close(),
    storage.blobs.close(),
    storage.materialization.close(),
  ]);
}

async function openConnections(storage: Storage): Promise<void> {
  try {
    await Promise.all([
      storage.structured.init(),
      storage.blobs.init(),
      storage.materialization.init(),
    ]);
    await storage.structured.spaces().ensureWorld();
  } catch (error) {
    await closeConnections(storage).catch(() => undefined);
    throw error;
  }
}

/** Prepare all connections for a Workspace without changing the active mount. */
export async function stageStorageForWorkspace(
  workspacePath: string,
  profile: StorageProfile = configuredProfile ?? parseStorageProfile(),
): Promise<StagedStorageMount> {
  const storage = createStorage(profile, workspacePath);
  await openConnections(storage);
  let state: 'staged' | 'active' | 'aborted' = 'staged';
  return Object.freeze({
    storage,
    async activate(): Promise<void> {
      if (state !== 'staged') {
        throw new Error(`Storage mount is already ${state}`);
      }
      // Refresh only process-local materialization locators after the
      // Workspace path has been committed. This performs no filesystem I/O;
      // fallible connection setup and World bootstrap happened while staged.
      storage.materialization.activate();
      state = 'active';
      const previous = current;
      current = storage;
      configuredProfile = profile;
      spaceCreateTail = Promise.resolve();
      if (previous && previous !== storage) {
        await closeConnections(previous).catch((error: unknown) => {
          log.error(
            { error, workspacePath: previous.workspacePath },
            'Previous Workspace storage did not close cleanly',
          );
        });
      }
    },
    async abort(): Promise<void> {
      if (state !== 'staged') return;
      state = 'aborted';
      await closeConnections(storage);
    },
  });
}

/**
 * Build the storage connections and open them.
 *
 * Called at server boot so an invalid profile surfaces immediately rather
 * than on the first upload.
 */
export async function initStorage(
  profile: StorageProfile = parseStorageProfile(),
): Promise<StorageRuntime> {
  validateStorageProfile(profile);
  configuredProfile = profile;
  if (!isWorkspaceConfigured()) {
    return { profile, mounted: false, workspacePath: null };
  }
  const staged = await stageStorageForWorkspace(getWorkspacePath(), profile);
  await staged.activate();
  return {
    profile,
    mounted: true,
    workspacePath: staged.storage.workspacePath,
  };
}

/** Close the current Workspace-bound connections during graceful shutdown. */
export async function closeStorage(): Promise<void> {
  const storage = current;
  current = null;
  if (storage) await closeConnections(storage);
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

export function getWorldCanvasId(): Promise<string> {
  return ensure().structured.spaces().worldId();
}

export async function isWorldCanvasId(canvasId: string): Promise<boolean> {
  return (await getWorldCanvasId()) === canvasId;
}

export function requireWorldCanvasId(): Promise<string> {
  return getWorldCanvasId();
}

export function getSpaceMaterialization(): SpaceMaterialization {
  return ensure().materialization;
}

/**
 * Create one ordinary Space through the selected structured backend.
 *
 * Default-title allocation and lifecycle creation share one process-local
 * serialization point. The Workspace lease is acquired before queueing, so
 * an async catalogue read cannot strand the request in a newly activated
 * Workspace and concurrent defaults remain Untitled, Untitled (1), ... .
 */
export function createSpace(
  canvasId: string,
  title?: string | null,
): Promise<SpaceCreateResult> {
  const structured = ensure().structured;
  const workspaceLease = acquireWorkspaceOperationLease();
  return serializeSpaceCreate(async () => {
    try {
      // One repository instance spans the read and the create, so a Workspace
      // switch between them is rejected by the handle rather than silently
      // creating the Space in the newly activated Workspace.
      const spaces = structured.spaces();
      const effectiveTitle =
        title === undefined ? defaultSpaceTitle(await spaces.list()) : title;
      return await spaces.create({ canvasId, title: effectiveTitle });
    } finally {
      workspaceLease.release();
    }
  });
}

/**
 * Delete one Space across the independently configured stores.
 *
 * The structured port deliberately does not accept a callback into the blob
 * store: that would make a database adapter hold a transaction while running
 * arbitrary remote I/O. Composition therefore owns the existing blob-first
 * saga. The process-local admission gate preserves today's single-server
 * ordering; it is not advertised as a distributed transaction guarantee.
 */
export async function deleteSpace(
  canvasId: string,
): Promise<SpaceDeleteOutcome> {
  const workspaceLease = acquireWorkspaceOperationLease();
  try {
    const storage = ensure();
    const started = await storage.structured.spaces().beginDelete({ canvasId });
    if (!started.ok) return started;
    try {
      // Preserve the old retryable cleanup behavior: sweep even when the
      // structured record is already absent, so orphan blobs can be removed.
      await storage.blobs.scope({ kind: 'canvas', canvasId }).deleteAll();
      return await started.session.finish();
    } catch (error) {
      await started.session.abort();
      throw error;
    }
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
    const record = await storage.structured.space(canvasId).read();
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

export async function storageHealth(): Promise<StorageHealth[]> {
  const storage = ensure();
  return Promise.all([
    storage.structured.health(),
    storage.blobs.health(),
    storage.materialization.health(),
  ]);
}

/**
 * The real directory backing a Space — the materialization capability.
 *
 * Some consumers genuinely need a filesystem path rather than a record: an
 * ACP agent needs a working directory, the external watcher needs something
 * to watch, RFS exposes a tree. That is a product requirement, not a leak
 * (proposal §12.5.4), and it is the Space-level counterpart to
 * `BlobScope.materialize()`.
 *
 * It lives in the composition root because only this module may ask a named
 * backend where anything is. Every profile selectable today materializes, so
 * this resolves unconditionally; a backend that stores Spaces without a
 * directory would refuse here rather than hand back a path that does not
 * exist.
 */
export function spaceDirectory(canvasId: string): string {
  return ensure().materialization.space(canvasId).directory();
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
