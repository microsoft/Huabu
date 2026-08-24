// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage composition root.
 *
 * Builds one {@link BlobStore} and one {@link StructuredStore} from a
 * validated {@link StorageProfile} and holds them for the process. This is
 * the only place that maps a backend kind to an adapter.
 *
 * The module-level holder is process-wide, while `workspace.ts` selects the
 * active namespace used through it. Workspace activation never reconstructs
 * these backend connections: a SQL adapter serves every Workspace through one
 * live connection or pool and scopes repository/handle operations by id. Call
 * {@link initStorage} from the server entry point so a bad profile fails at
 * startup with an actionable message.
 *
 * Anything that reaches for storage without that — tests, scripts — builds
 * the adapters on demand. That path is synchronous, so it cannot `await
 * init()`, and it is therefore only legal for backends that have nothing to
 * open; see {@link requiresExplicitInit}. It is not a lazy version of
 * {@link initStorage}, and a connection-holding backend must not be reached
 * through it.
 */

import path from 'node:path';

import { getDataDir } from '../../data-dir.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspacePath,
} from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
import { stageDiskSpaceImport } from './backends/disk/space-import.js';
import { diskSpaceTree } from './backends/disk/space-tree.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import {
  DiskWorkspaceRepository,
  workspaceRegistryPath,
} from './backends/disk/workspace-repository.js';
import {
  parseStorageProfile,
  requiresExplicitInit,
  StorageProfileError,
  validateStorageProfile,
  type StorageProfile,
} from './profile.js';
import { withSpacePutAdmission } from './space-lifecycle-admission.js';

import type { DiskSpaceImport } from './backends/disk/space-import.js';
import type { DiskSpaceTree } from './backends/disk/space-tree.js';
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
  SpaceHandle,
  StructuredStore,
} from './ports/structured.js';
import type {
  WorkspaceHandle,
  WorkspaceRepository,
} from './ports/workspace.js';
import type { Readable } from 'node:stream';

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
  readonly structured: StructuredStore;
  readonly blobs: BlobStore;
  /**
   * Every storage capability for one Space, from one call.
   *
   * A Space's durable state spans both ports — its record and nodes are
   * structured, its files are bytes — so the application reaches all of it
   * through one object rather than remembering which axis holds what
   * (§6.4.1).
   */
  space(canvasId: string): Space;
}

/**
 * One Space across every axis that holds part of it.
 *
 * A **composition-layer facade, not a port type**. `StructuredStore.space()`
 * keeps returning the structured-only {@link SpaceHandle}, `BlobStore.scope()`
 * keeps returning a {@link BlobScope}, and neither port imports the other.
 * They are joined here because this is the only object in the process that
 * holds both, and because this layer already owns every cross-store rule: the
 * blob-put precondition and the blob-first delete saga.
 *
 * The join cannot move down into a port. The two axes are configured
 * independently, so a `SpaceHandle` that vended blobs would oblige the Disk
 * structured adapter to construct an Azure blob scope; deletion ordering
 * deliberately keeps remote blob I/O outside any database transaction; and
 * `BlobScopeRef` covers scopes that have no Space at all, which a blob store
 * reachable only through a Space handle could not serve.
 */
export interface Space extends SpaceHandle {
  /**
   * This Space's blobs, with the cross-store precondition applied.
   *
   * Bytes may only be added to a Space whose record exists. Reads and
   * `deleteAll()` stay available for cleanup when a record has already gone.
   */
  readonly blobs: BlobScope;
  /**
   * Disk's directory for this Space. `null` on every other backend.
   *
   * A capability only some backends implement, named for the backend that has
   * it and typed by its absence — not hidden behind a parallel free function,
   * and not a stub that throws. A caller branching on `null` is told the truth
   * once; a caller that must remember a second import is being asked to know
   * this module's internal topology.
   */
  readonly diskTree: DiskSpaceTree | null;
}

function composeSpace(storage: Storage, canvasId: string): Space {
  const handle = storage.structured.space(canvasId);
  return {
    canvasId: handle.canvasId,
    read: () => handle.read(),
    write: (input) => handle.write(input),
    nodes: handle.nodes,
    changes: handle.changes,
    tasks: handle.tasks,
    events: handle.events,
    blobs: guardedBlobScope(storage, canvasId),
    diskTree:
      storage.profile.structured.kind === 'disk'
        ? diskSpaceTree(canvasId)
        : null,
  };
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

/**
 * Assemble a {@link Storage} from connections the caller already holds.
 *
 * Does not validate the profile and opens nothing — it only wires the Space
 * facade over two given stores. Exists so anything holding its own
 * connections composes the same facade the process does, rather than a
 * partial object literal that would go stale the next time {@link Storage}
 * gains a member.
 */
export function composeStorage(
  profile: StorageProfile,
  structured: StructuredStore,
  blobs: BlobStore,
): Storage {
  return {
    profile,
    structured,
    blobs,
    // Composes from the receiver, not from a captured local. Substituting one
    // axis by spreading — `{...storage, blobs: fake}` — is the obvious way to
    // stub a backend, and a closure over the original object would hand that
    // copy Spaces built on the stores it just replaced, silently.
    space(this: Storage, canvasId: string): Space {
      return composeSpace(this, canvasId);
    },
  };
}

/** Validate a profile and construct both connections. Does not `init()`. */
export function createStorage(profile: StorageProfile): Storage {
  validateStorageProfile(profile);
  return composeStorage(
    profile,
    buildStructuredStore(profile),
    buildBlobStore(profile),
  );
}

// ─── Process-wide holder ────────────────────────────────────────────────────

let current: Storage | null = null;
let workspaces: DiskWorkspaceRepository | null = null;
let spaceCreateTail: Promise<void> = Promise.resolve();

/**
 * The Workspace repository for the configured structured backend.
 *
 * Workspace identity is a *precondition* of storage rather than a product of
 * it: every Disk adapter resolves its paths against the active Workspace, and
 * managed mode has to adopt its Workspace while `app.ts` is still evaluating —
 * before the boot sequence can await {@link initStorage}. Routing it through
 * {@link getStructuredStore} would therefore drag the whole composition open
 * on the on-demand path, which that path explicitly refuses for a backend with
 * connections to hold.
 *
 * So the composition root owns this axis separately. It still maps a backend
 * kind to exactly one adapter, and it holds one instance for the process.
 * Connection-backed adapters expose Workspace membership through that same
 * process-wide connection or pool; switching the active Workspace selects a
 * namespace and never drops or reconnects the backend. Their repository is
 * wired during awaited startup rather than through the on-demand path.
 */
export function getWorkspaceRepository(): WorkspaceRepository {
  return materializedWorkspaces();
}

/** Whether the Disk Workspace membership registry already exists on disk. */
export function hasWorkspaceRegistry(): boolean {
  return materializedWorkspaces().hasDurableRegistry();
}

/**
 * The Workspace repository, narrowed to a backend that materializes
 * Workspaces as real directories.
 *
 * This is the Workspace-level twin of {@link Space.diskTree}: the port
 * deliberately says nothing about where a Workspace is, because a backend
 * that keeps Workspaces in a database has no directory to name and must not
 * be made to invent one. Only this module may ask a named backend where
 * anything is, so the locator resolves here — and a non-materializing profile
 * refuses outright rather than handing back a path that does not exist.
 */
function materializedWorkspaces(): DiskWorkspaceRepository {
  if (workspaces) return workspaces;

  const profile = parseStorageProfile();
  if (profile.structured.kind !== 'disk') {
    throw new StorageProfileError(
      `The "${profile.structured.kind}" structured backend does not materialize ` +
        `Workspaces as directories. Implement a locator for it before using ` +
        `directory-shaped Workspace activation.`,
    );
  }
  workspaces = new DiskWorkspaceRepository(workspaceRegistryPath(getDataDir()));
  return workspaces;
}

/**
 * Adopt a real directory as a Workspace, creating its manifest if the folder
 * predates one, and record its membership.
 */
export function adoptWorkspaceDirectory(
  workspacePath: string,
): WorkspaceHandle {
  return materializedWorkspaces().adopt(workspacePath);
}

/** The registered Workspace materialized at a directory, if there is one. */
export function workspaceAtDirectory(
  workspacePath: string,
): WorkspaceHandle | null {
  return materializedWorkspaces().at(workspacePath);
}

/** The directory backing a registered Workspace, or null if it is not one. */
export function workspaceDirectory(workspaceId: string): string | null {
  return materializedWorkspaces().directoryOf(workspaceId);
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
 * Blob scope for one Space, with the cross-store precondition applied.
 *
 * The raw BlobStore intentionally knows nothing about structured lifecycle,
 * so composition owns the one cross-store invariant: bytes may only be added
 * to a Space whose record exists. Reads and `deleteAll()` stay available for
 * cleanup/recovery when a record has already gone missing.
 *
 * Takes its {@link Storage} rather than resolving the process-wide holder, so
 * one Space facade is composed entirely from the connections it was built
 * against — a scope that re-resolved the holder could outlive them.
 */
function guardedBlobScope(storage: Storage, canvasId: string): BlobScope {
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
  return Promise.all([storage.structured.health(), storage.blobs.health()]);
}

/**
 * Open a staging area for one imported Space, or `null` off Disk.
 *
 * Bundle import is Disk-only and declared as such. It is not a member of
 * {@link Space} because it addresses a Space that does not exist yet — there
 * is nothing to hang it off until it has been published.
 */
export function stageSpaceImport(canvasId: string): DiskSpaceImport | null {
  return ensure().profile.structured.kind === 'disk'
    ? stageDiskSpaceImport(canvasId)
    : null;
}

/**
 * Every storage capability for one Space — the shorthand call sites use.
 *
 * Exactly `getStorage().space(canvasId)`, and an ergonomic spelling of the
 * same method rather than a second design. One function answers every storage
 * question about a Space: its record, its nodes, its logs, its Tasks, its
 * bytes, and — where the backend has one — its directory.
 */
export function space(canvasId: string): Space {
  return ensure().space(canvasId);
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
