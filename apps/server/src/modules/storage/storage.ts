// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage composition root.
 *
 * Builds one {@link BlobStore} and one {@link StructuredStore} from a
 * validated {@link StorageProfile} and holds them for the process. This is
 * the only place that maps a backend kind to an adapter.
 *
 * The lifecycle is linear, because the Workspace a process serves is fixed
 * for its lifetime (proposal §12.6.5): mount once, serve, close on shutdown.
 * Selecting a different Workspace is a restart, so there is no remount, no
 * staged swap, and nothing here has to describe *which* Workspace it was
 * opened against — a mount that exists is the mount for the Workspace this
 * process serves. Call {@link initStorage} from the server entry point so a
 * bad profile fails at startup with an actionable message, before anything
 * has been opened.
 *
 * Anything that reaches for storage without a mount — tests, scripts — builds
 * the adapters on demand. That path is synchronous, so it cannot `await
 * init()`, and it is therefore only legal for backends that have nothing to
 * open; see {@link requiresExplicitInit}. It is not a lazy version of the
 * mount, and a connection-holding backend must not be reached through it.
 */

import { isWorkspaceConfigured } from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
import { resetStorageCache } from './backends/disk/legacy/canvas-store-cache.js';
import { clearAllNodeTombstones } from './backends/disk/legacy/node-tombstones.js';
import { stageDiskSpaceImport } from './backends/disk/space-import.js';
import { diskSpaceTree } from './backends/disk/space-tree.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import { spaceBlobAreas } from './ports/blob.js';
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
  SpaceBlobs,
} from './ports/blob.js';
import type { StorageHealth } from './ports/common.js';
import type {
  SpaceCreateResult,
  SpaceDeleteFinishResult,
  SpaceHandle,
  StructuredStore,
} from './ports/structured.js';
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
 * returns the structured {@link SpaceHandle}, `BlobStore.space()` returns the
 * {@link SpaceBlobs} areas, and neither port imports the other. They are
 * joined here because this is the only object in the process that holds both,
 * and because this layer already owns the one cross-store rule the join needs:
 * bytes may only be added to a Space whose record exists.
 *
 * The join cannot move down into a port. The two axes are configured
 * independently, so a `SpaceHandle` that vended blobs would oblige the Disk
 * structured adapter to construct an Azure blob handle, and deletion ordering
 * deliberately keeps remote blob I/O outside any database transaction.
 *
 * Every member is a durable part of one Space, flat: which axis stores a part
 * is this module's business, not its callers' (§6.4.1).
 */
export interface Space extends SpaceHandle, SpaceBlobs {
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
  const blobs = storage.blobs.space(canvasId);
  const guarded = (scope: BlobScope): BlobScope =>
    guardedBlobScope(storage, canvasId, scope);
  return {
    canvasId: handle.canvasId,
    read: () => handle.read(),
    write: (input) => handle.write(input),
    nodes: handle.nodes,
    changes: handle.changes,
    tasks: handle.tasks,
    events: handle.events,
    extension: (namespace) => handle.extension(namespace),
    artifacts: guarded(blobs.artifacts),
    guide: guarded(blobs.guide),
    memory: guarded(blobs.memory),
    uploads: guarded(blobs.uploads),
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

/**
 * Validate a profile and construct both connections.
 *
 * Does not `init()` — opening is the mount's job, so a caller can build a
 * connection it has not committed to using.
 */
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
let spaceCreateTail: Promise<void> = Promise.resolve();

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
  // mount complaint below.
  const storage = createStorage(profile);
  if (requiresExplicitInit(profile)) {
    throw new StorageProfileError(
      `Storage was used before it was mounted. The ` +
        `"${profile.structured.kind}" / "${profile.blobs.kind}" profile has ` +
        `connections to open, and this path cannot await init(). Mount it ` +
        `during startup instead.`,
    );
  }
  current = storage;
  return current;
}

// ─── Workspace mount lifecycle ──────────────────────────────────────────────

async function closeQuietly(storage: Storage): Promise<void> {
  await Promise.all([
    storage.structured.close().catch(() => undefined),
    storage.blobs.close().catch(() => undefined),
  ]);
}

/**
 * Open both connections for the active Workspace and bootstrap its World.
 *
 * The whole lifecycle, because a process serves one Workspace: this runs once,
 * after the Workspace path has been committed and before anything is served.
 * A rejection leaves the process with no mount, which is the honest outcome —
 * the alternative is serving a Workspace whose World was never established.
 */
export async function mountStorage(
  profile: StorageProfile = parseStorageProfile(),
): Promise<Storage> {
  await closeStorage();
  const storage = createStorage(profile);
  try {
    await Promise.all([storage.structured.init(), storage.blobs.init()]);
    // Every backend meets an empty namespace the first time it is mounted, and
    // a Workspace with no World has no Portal target.
    await storage.structured.spaces().ensureWorld();
  } catch (error) {
    await closeQuietly(storage);
    throw error;
  }
  current = storage;
  return storage;
}

/**
 * Drop the process's storage state without closing it.
 *
 * The synchronous counterpart to {@link closeStorage}, for a caller that
 * cannot await — {@link commitWorkspacePath} publishing a Workspace, and the
 * tests that move between temporary ones. A backend whose `close()` matters is
 * one {@link ensure} refuses to rebuild here anyway, so nothing that holds a
 * connection is reachable through this path.
 *
 * The mount, the Disk adapter's instance cache, and its node fences go
 * together: all three describe whichever Workspace was active, and none of
 * them carries an answer to *which* one, because a process only ever has the
 * one.
 */
export function resetStorage(): void {
  current = null;
  resetStorageCache();
  clearAllNodeTombstones();
}

/** Close the active mount. Called on graceful Server shutdown. */
export async function closeStorage(): Promise<void> {
  const previous = current;
  current = null;
  if (previous) await closeQuietly(previous);
}

/**
 * Validate the configured profile, and mount it when a Workspace is active.
 *
 * Called at server boot so an unknown or unimplemented backend fails there
 * with an actionable message rather than on the first upload. A free-mode
 * process may still be waiting for the user to choose a folder, so this
 * validates and returns without opening anything; the mount then happens when
 * one is activated, once.
 */
export async function initStorage(
  profile: StorageProfile = parseStorageProfile(),
): Promise<Storage | null> {
  validateStorageProfile(profile);
  if (!isWorkspaceConfigured()) return null;
  return mountStorage(profile);
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
 * serialization point, so concurrent defaults remain Untitled, Untitled (1),
 * ... rather than colliding on one name.
 */
export function createSpace(
  canvasId: string,
  title?: string | null,
): Promise<SpaceCreateResult> {
  const structured = ensure().structured;
  return serializeSpaceCreate(async () => {
    const spaces = structured.spaces();
    const effectiveTitle =
      title === undefined ? defaultSpaceTitle(await spaces.list()) : title;
    return spaces.create({ canvasId, title: effectiveTitle });
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
  const storage = ensure();
  const started = await storage.structured.spaces().beginDelete({ canvasId });
  if (!started.ok) return started;
  try {
    // Preserve the old retryable cleanup behavior: sweep even when the
    // structured record is already absent, so orphan blobs can be removed.
    // Every area, not just artifacts: a Space's bytes are spread across one
    // area per user-visible place, and on a backend where dropping the
    // structured record does not remove that place, an unswept area is an
    // orphan.
    await Promise.all(
      spaceBlobAreas(storage.blobs.space(canvasId)).map((area) =>
        area.deleteAll(),
      ),
    );
    return await started.session.finish();
  } catch (error) {
    await started.session.abort();
    throw error;
  }
}

/**
 * One blob area, with the cross-store precondition applied.
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
function guardedBlobScope(
  storage: Storage,
  canvasId: string,
  delegate: BlobScope,
): BlobScope {
  async function requireSpace(): Promise<void> {
    const record = await storage.structured.space(canvasId).read();
    if (!record) {
      throw new Error(`Cannot write blobs for missing Space "${canvasId}"`);
    }
  }

  return {
    async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
      try {
        return await withSpacePutAdmission(canvasId, async () => {
          await requireSpace();
          return delegate.put(name, body);
        });
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
