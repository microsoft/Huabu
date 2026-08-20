// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage composition root.
 *
 * Builds one {@link BlobStore} and one {@link StructuredStore} from a
 * validated {@link StorageProfile} and holds them for the process. This is
 * the only place that maps a backend kind to an adapter.
 *
 * A mount belongs to one Workspace. Switching Workspaces is therefore a
 * remount rather than a reconfiguration in place, and the lifecycle that does
 * it — {@link stageStorage} / {@link StagedStorage.commit} — exists so every
 * step that can fail happens while the previous Workspace is still serving
 * (proposal §12.6.5). Call {@link initStorage} from the server entry point so
 * a bad profile fails at startup with an actionable message, before anything
 * has been opened.
 *
 * Anything that reaches for storage without going through a mount — tests,
 * scripts, the synchronous Workspace switch — builds the adapters on demand.
 * That path is synchronous, so it cannot `await init()`, and it is therefore
 * only legal for backends that have nothing to open; see
 * {@link requiresExplicitInit}. It is not a lazy version of the mount, and a
 * connection-holding backend must not be reached through it.
 */

import path from 'node:path';

import {
  acquireWorkspaceOperationLease,
  getWorkspacePath,
  isWorkspaceConfigured,
} from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
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
  /**
   * Workspace these connections were opened against.
   *
   * A mount belongs to one Workspace. Switching Workspaces is a remount, not
   * a reconfiguration of the connections in place, so this is what makes a
   * stale mount recognisable rather than silently serving the wrong data.
   */
  readonly workspacePath: string;
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
  workspacePath: string,
  structured: StructuredStore,
  blobs: BlobStore,
): Storage {
  return {
    profile,
    workspacePath: path.resolve(workspacePath),
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
 * Validate a profile and construct both connections for one Workspace.
 *
 * Does not `init()` — opening is the mount's job, so a caller can build a
 * connection it has not committed to using.
 */
export function createStorage(
  profile: StorageProfile,
  workspacePath: string,
): Storage {
  validateStorageProfile(profile);
  return composeStorage(
    profile,
    workspacePath,
    buildStructuredStore(profile, workspacePath),
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
  const workspacePath = activeWorkspacePath();
  if (current) {
    if (current.workspacePath === workspacePath) return current;
    // The active Workspace moved without going through the mount lifecycle —
    // the synchronous `setWorkspacePath` path, and the tests that drive it.
    // Drop the stale mount rather than serving another Workspace's data
    // through it; the rebuild below either succeeds or says why it cannot.
    current = null;
  }

  const profile = parseStorageProfile();
  // Build first, so an unimplemented backend reports that rather than the
  // mount complaint below.
  const storage = createStorage(profile, workspacePath);
  if (requiresExplicitInit(profile)) {
    throw new StorageProfileError(
      `Storage is not mounted on the active Workspace. The ` +
        `"${profile.structured.kind}" / "${profile.blobs.kind}" profile has ` +
        `connections to open, and this path cannot await init(). Activate the ` +
        `Workspace through the mount lifecycle instead.`,
    );
  }
  current = storage;
  return current;
}

// ─── Workspace mount lifecycle ──────────────────────────────────────────────

/**
 * Connections opened for a Workspace that is not active yet.
 *
 * Staging exists so activation can fail without consequences. Everything that
 * can go wrong — an unimplemented backend, a connection that will not open, a
 * namespace whose World is malformed — happens here, while the previous
 * Workspace and its connections are still serving. Only {@link commit} makes
 * the new mount reachable, and it cannot fail.
 */
export interface StagedStorage {
  readonly storage: Storage;
  /**
   * Publish this mount and close the one it replaced.
   *
   * `publish` is the caller's own commit — for a Workspace switch, making the
   * new path the active one. It runs in the same synchronous block as the
   * swap, so no request can land in a gap where the path has moved but the
   * mount serving it has not. Closing the replaced connections happens after,
   * where a slow close cannot delay the first request against the new
   * Workspace.
   *
   * A `publish` that throws leaves the active mount exactly as it was; the
   * caller should then {@link abort}. The swap itself cannot fail.
   */
  commit(publish?: () => void): Promise<void>;
  /** Close the staged connections. The active mount is untouched. */
  abort(): Promise<void>;
}

async function closeQuietly(storage: Storage): Promise<void> {
  await Promise.all([
    storage.structured.close().catch(() => undefined),
    storage.blobs.close().catch(() => undefined),
  ]);
}

/**
 * Open connections for `workspacePath` and bootstrap its World.
 *
 * Does not touch the active mount, the active Workspace path, or any
 * process-wide state. A rejection here leaves the previous Workspace fully
 * serving, which is the whole point of separating this from {@link
 * StagedStorage.commit} (proposal §12.6.5).
 */
export async function stageStorage(
  workspacePath: string,
  profile: StorageProfile = parseStorageProfile(),
): Promise<StagedStorage> {
  // The mount this one replaces, captured now rather than at commit time.
  // Committing a Workspace path detaches the mount that no longer describes
  // it, so by the time the swap runs there may be nothing left to read — and
  // the connections would never be closed.
  const replaced = current;
  const storage = createStorage(profile, workspacePath);
  try {
    await Promise.all([storage.structured.init(), storage.blobs.init()]);
    // Every backend meets an empty namespace the first time it is mounted, and
    // a Workspace with no World has no Portal target. This runs before the
    // path is committed, so it must address the Workspace being staged rather
    // than the active one — which is why the connection is constructed with an
    // explicit path.
    await storage.structured.spaces().ensureWorld();
  } catch (error) {
    await closeQuietly(storage);
    throw error;
  }

  return {
    storage,
    async commit(publish?: () => void): Promise<void> {
      publish?.();
      current = storage;
      if (replaced && replaced !== storage) await closeQuietly(replaced);
    },
    /** Leaves `replaced` alone — it is still the active mount. */
    abort(): Promise<void> {
      return closeQuietly(storage);
    },
  };
}

/**
 * Mount storage onto `workspacePath` in one step.
 *
 * For callers that have nothing to do between staging and publishing. An
 * activation that must commit the Workspace path between the two — every
 * runtime switch — drives {@link stageStorage} directly instead.
 */
export async function mountStorage(
  workspacePath: string,
  profile?: StorageProfile,
): Promise<Storage> {
  const staged = await stageStorage(workspacePath, profile);
  await staged.commit();
  return staged.storage;
}

/**
 * Detach the current mount without closing it, returning what was detached.
 *
 * The escape hatch for the synchronous Workspace switch, which cannot await a
 * close. Returning the detached mount rather than closing it here keeps the
 * decision with the caller: a backend whose `close()` matters is one that
 * cannot be reached through the synchronous path anyway, because `ensure()`
 * refuses to build it.
 */
export function detachStorage(): Storage | null {
  const previous = current;
  current = null;
  return previous;
}

/** Close the active mount. Called on graceful Server shutdown. */
export async function closeStorage(): Promise<void> {
  const previous = detachStorage();
  if (previous) await closeQuietly(previous);
}

/**
 * Validate the configured profile, and mount it when a Workspace is already
 * active.
 *
 * Called at server boot so an unknown or unimplemented backend fails there
 * with an actionable message rather than on the first upload. In free mode
 * there is no Workspace yet, so this validates and returns without opening
 * anything; the mount happens when one is activated.
 */
export async function initStorage(
  profile: StorageProfile = parseStorageProfile(),
): Promise<Storage | null> {
  validateStorageProfile(profile);
  if (!isWorkspaceConfigured()) return null;
  return mountStorage(activeWorkspacePath(), profile);
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
      // Every area, not just artifacts: a Space's bytes are spread across one
      // scope per user-visible area, and on a backend where dropping the
      // structured record does not remove the area they sit in, an unswept
      // kind is an orphan.
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
  } finally {
    workspaceLease.release();
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
  const workspacePath = activeWorkspacePath();

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
