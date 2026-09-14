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

import { rm } from 'node:fs/promises';

import {
  acquireWorkspaceOperationLease,
  commitWorkspaceIdentity,
  getWorkspaceHandle,
  getWorkspaceKey,
} from '../workspace.js';
import { DiskBlobStore } from './backends/disk/blob-store.js';
import { getWorldCanvasId as diskWorldCanvasId } from './backends/disk/canvas-dirs.js';
import {
  diskSpaceBlobRoot,
  workspaceRegistryPath,
} from './backends/disk/data-dir.js';
import { canvasRoot } from './backends/disk/layout.js';
import { stageDiskSpaceImport } from './backends/disk/space-import.js';
import { diskSpaceTree } from './backends/disk/space-tree.js';
import { DiskStructuredStore } from './backends/disk/structured-store.js';
import { DiskWorkspaceRepository } from './backends/disk/workspace-repository.js';
import {
  SqliteStoreContext,
  sqliteDatabasePath,
} from './backends/sqlite/database.js';
import { SqliteStructuredStore } from './backends/sqlite/structured-store.js';
import { SqliteWorkspaceRepository } from './backends/sqlite/workspace-repository.js';
import { hasStorageCapability } from './capabilities.js';
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
import type { SqliteSpaceSubstrate } from './backends/sqlite/space-extension.js';
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

/**
 * The active Workspace as an identity to compare, not a location.
 *
 * The blob put saga has to prove that the Workspace has not changed under an
 * awaited operation. On Disk that comparison was the resolved path; a
 * Workspace that is a row has no path, so the key is what both backends can
 * answer with.
 */
function activeWorkspaceKey(): string {
  return getWorkspaceKey();
}

function assertActiveWorkspace(workspaceKey: string, canvasId: string): void {
  if (activeWorkspaceKey() !== workspaceKey) {
    throw new Error(
      `Blob scope for Space "${canvasId}" belongs to an inactive workspace. ` +
        `Resolve a fresh scope after workspace activation.`,
    );
  }
}

/**
 * Where a Space keeps its bytes when the structured backend has no folder for
 * it.
 *
 * Blobs are always files (`ports/blob.ts`), so a profile whose records are
 * rows still needs somewhere on a file system for uploads, artifacts, the
 * guide document and the memory body. *Which* directory is the Disk blob
 * adapter's own business — this only supplies the Workspace the Space belongs
 * to, which is the one part of the answer the adapter cannot know.
 */
function detachedSpaceRoot(canvasId: string): string {
  const workspace = getWorkspaceHandle();
  if (!workspace) {
    throw new Error(
      `Blob scope for Space "${canvasId}" needs an active Workspace. ` +
        'Activate one before reading or writing bytes.',
    );
  }
  return diskSpaceBlobRoot(workspace.workspaceId, canvasId);
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
  /**
   * SQLite's connection point for an extension namespace, without awaiting.
   * `null` on every other backend.
   *
   * The same shape as {@link diskTree} and there for the same reason: a
   * capability one backend has, named for it and typed by its absence. What
   * makes it worth its own member rather than the port's `extension()` is
   * that it is *synchronous*. An owner whose own interface is synchronous —
   * the Agenetes conversation stores — can resolve its place at the moment it
   * needs it instead of keeping a cache primed from somewhere else.
   */
  readonly sqliteTree: SqliteSpaceTree | null;
}

/** What a namespace can ask of the SQLite backend for one Space. */
export interface SqliteSpaceTree {
  /**
   * This namespace's connection point, created on demand.
   *
   * `null` when the Space does not exist — the same refusal the port's
   * `extension()` makes, and for the same reason.
   */
  extension(namespace: string): SqliteSpaceSubstrate | null;
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
    sqliteTree:
      storage.structured instanceof SqliteStructuredStore
        ? {
            extension: (namespace: string) =>
              (storage.structured as SqliteStructuredStore).extensionSync(
                canvasId,
                namespace,
              ),
          }
        : null,
  };
}

/**
 * The blob connection for this profile, and where it puts a Space's bytes.
 *
 * `blobs=disk` names a *medium* — bytes are local files — so there is one
 * adapter. The place is composition's to choose, and the rule is one sentence:
 * **a Space's bytes live with the Space.**
 *
 * Where the structured backend files a Space as a directory, that directory is
 * where the Space *is*, so the bytes go inside it. That is not only
 * backward-compatibility with every Workspace that already exists: a Space
 * folder being self-contained is what several declared capabilities are made
 * of. `.huabu.zip` export is that folder archived, reveal-in-file-manager
 * shows it, RFS projects it, and the built-in file tools sandbox on it.
 * Relocating artifacts to a Server-owned root would quietly hollow out all
 * four while every one of them still reported as available.
 *
 * Where a Space is a row it has no directory to be inside, so the adapter gets
 * a root of its own under the Disk backend's data-directory area.
 *
 * One rule, two outcomes, because a Space has two possible homes — not two
 * meanings for `blobs=disk`. The corollary is a genuine cross-axis constraint
 * for the day a blob backend cannot co-locate: an object store would put bytes
 * outside the Space folder even on Disk records, and the four capabilities
 * above would then depend on both axes rather than the structured one alone
 * (see `capabilities.ts`).
 */
function buildBlobStore(profile: StorageProfile): BlobStore {
  if (profile.blobs.kind !== 'disk') {
    // Unreachable: validateStorageProfile rejects unimplemented kinds.
    throw new Error(`Unsupported blob backend: ${profile.blobs.kind}`);
  }
  return new DiskBlobStore(
    profile.structured.kind === 'disk' ? canvasRoot : detachedSpaceRoot,
  );
}

function buildStructuredStore(profile: StorageProfile): StructuredStore {
  switch (profile.structured.kind) {
    case 'disk':
      return new DiskStructuredStore();
    case 'sqlite':
      return new SqliteStructuredStore(sqliteConnection());
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
let workspaces: WorkspaceRepository | null = null;
let sqlite: SqliteStoreContext | null = null;
let activeWorldCanvasId: string | null = null;
let spaceCreateTail: Promise<void> = Promise.resolve();

/**
 * The one SQLite connection this process holds, opened on first need.
 *
 * Opening it is synchronous, which is why the on-demand path stays legal for
 * this profile: there is no `await` to skip. The structured store and the
 * Workspace repository both borrow it, because they are one database file and
 * a second connection would be a second writer.
 */
function sqliteConnection(): SqliteStoreContext {
  if (sqlite) return sqlite;
  const context = new SqliteStoreContext(sqliteDatabasePath());
  context.init();
  sqlite = context;
  return context;
}

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
  if (workspaces) return workspaces;
  const profile = activeProfile();
  workspaces =
    profile.structured.kind === 'sqlite'
      ? new SqliteWorkspaceRepository(sqliteConnection())
      : new DiskWorkspaceRepository(workspaceRegistryPath());
  return workspaces;
}

/**
 * Whether the profile in force serves `id`.
 *
 * The one form application code should use. `hasStorageCapability` takes a
 * profile, and the only profile worth asking about is the one storage was
 * actually opened with — a call site that parses the environment instead gets
 * a different answer the moment a test or an embedder mounts an explicit
 * profile. Binding it here removes the choice.
 *
 * Ask this in a refusal. Code that degrades to absence instead of refusing
 * should keep asking the concrete predicate it depends on; see
 * `capabilities.ts`.
 */
export function storageServes(id: string): boolean {
  return hasStorageCapability(activeProfile(), id);
}

/**
 * Whether the Disk Workspace membership registry already exists on disk.
 *
 * `false` off Disk, where there is no such registry to import into: the one
 * caller is the deprecated desktop-store import, which is a Disk migration.
 */
export function hasWorkspaceRegistry(): boolean {
  if (!materializesWorkspaces()) return false;
  return materializedWorkspaces().hasDurableRegistry();
}

/**
 * Whether the configured backend gives a Workspace a real directory.
 *
 * The one question the rest of the Server should ask before reaching for a
 * Workspace path: everything that follows from "no" — no folder picker, no
 * bundle import, no user skills directory — is a stated capability rather
 * than a runtime surprise.
 */
export function materializesWorkspaces(): boolean {
  return activeProfile().structured.kind === 'disk';
}

/**
 * The profile in force, preferring the one storage was actually opened with.
 *
 * The environment answers before startup — managed mode adopts its Workspace
 * while `app.ts` is still evaluating — but once `initStorage` has run, the
 * profile it was handed is the truth. A test that mounts an explicit profile
 * would otherwise get a Workspace repository for whatever the environment
 * happened to say.
 */
function activeProfile(): StorageProfile {
  return current?.profile ?? parseStorageProfile();
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
  const repository = getWorkspaceRepository();
  if (!(repository instanceof DiskWorkspaceRepository)) {
    const profile = parseStorageProfile();
    throw new StorageProfileError(
      `The "${profile.structured.kind}" structured backend does not materialize ` +
        `Workspaces as directories, so there is no folder to adopt, reveal, or ` +
        `resolve. Select the disk structured backend for directory-shaped ` +
        `Workspace activation.`,
    );
  }
  return repository;
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

/**
 * Create a Workspace that has no directory.
 *
 * The counterpart to {@link adoptWorkspaceDirectory} for a backend where a
 * Workspace is a row: nothing to adopt, so a name is the whole of it. It is
 * not a port member for the same reason locating a Workspace is not — Disk
 * could only serve it by inventing a folder the user never picked, and the
 * point of the port is that it says nothing about where a Workspace is.
 *
 * A deployment that keeps Workspaces in a database needs this to hold more
 * than the one the Server opens for itself, which is the whole of multi-
 * Workspace support there: every other operation — list, activate, rename,
 * forget — is already on the port.
 */
export function createNamedWorkspace(name: string): Promise<WorkspaceHandle> {
  const repository = getWorkspaceRepository();
  if (!(repository instanceof SqliteWorkspaceRepository)) {
    throw new StorageProfileError(
      `The "${activeProfile().structured.kind}" structured backend keeps ` +
        'Workspaces as directories, so a Workspace is created by adopting a ' +
        'folder rather than by name.',
    );
  }
  return repository.create(name);
}

/** The registered Workspace materialized at a directory, if there is one. */
export function workspaceAtDirectory(
  workspacePath: string,
): WorkspaceHandle | null {
  return materializedWorkspaces().at(workspacePath);
}

/**
 * The directory backing a registered Workspace, or `null` if there is none.
 *
 * `null` covers both "not a registered Workspace" and "this backend does not
 * put Workspaces in folders". Callers already handle the first, and treating
 * the second the same way is what lets a listing render on either backend
 * instead of failing whole.
 */
export function workspaceDirectory(workspaceId: string): string | null {
  if (!materializesWorkspaces()) return null;
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
  // Rebuild the Workspace repository against this profile: a repository
  // memoized from the environment before an explicit profile was chosen would
  // answer for the wrong backend.
  workspaces = null;
  const storage = createStorage(profile);
  await Promise.all([storage.structured.init(), storage.blobs.init()]);
  current = storage;
  await ensureActiveWorkspace(profile);
  return storage;
}

/**
 * Make sure a Workspace is active, for a backend that can decide by itself.
 *
 * On Disk the Workspace is a folder the user chooses, so the Server waits.
 * Where a Workspace is a row there is nothing to choose and nothing to ask
 * for: the first start creates one and activates it, and the app is usable
 * without a setup step. A Workspace already activated — by managed mode, or
 * by a previous call — is left alone.
 */
async function ensureActiveWorkspace(profile: StorageProfile): Promise<void> {
  if (profile.structured.kind !== 'sqlite') return;
  const repository = getWorkspaceRepository();
  if (!(repository instanceof SqliteWorkspaceRepository)) return;
  // The question is whether *this connection* is pointed at a Workspace, not
  // whether the process remembers one. A handle left over from a previous
  // profile is a name without a namespace behind it.
  if (sqliteConnection().activeWorkspaceId() !== null) return;
  const workspace = await repository.ensureDefault(DEFAULT_WORKSPACE_NAME);
  await activateWorkspace(workspace);
}

/** The name a SQL deployment's first Workspace is given. */
const DEFAULT_WORKSPACE_NAME = 'Workspace';

/**
 * Select one Workspace as the process's active namespace.
 *
 * Two things have to agree: the Server's own active-Workspace state and the
 * namespace the backend scopes its queries to. Doing both here keeps them
 * from drifting — a connection still pointed at the previous Workspace would
 * answer confidently with the wrong Spaces.
 */
export async function activateWorkspace(
  workspace: WorkspaceHandle,
): Promise<void> {
  // The lease guard must accept the switch before either cached World state
  // or the SQLite connection moves away from the current Workspace.
  commitWorkspaceIdentity(workspace);
  if (sqlite) sqlite.useWorkspace(workspace.workspaceId);
  activeWorldCanvasId = null;
  if (workspaces instanceof SqliteWorkspaceRepository) {
    workspaces.markOpened(workspace.workspaceId);
  }
  // A Workspace with no World has no Portal target and no home view. On Disk
  // the World is written by workspace preparation; here the same step belongs
  // to activation, because activation is the whole of "open a Workspace".
  activeWorldCanvasId = await ensure().structured.spaces().ensureWorld();
}

/**
 * The hidden World Space of the active Workspace, or `null` before one is
 * opened.
 *
 * Disk answers from its directory index, which re-scans, so a Workspace edited
 * from outside the app stays correct. Elsewhere the id is remembered from
 * activation: it is minted once per Workspace and never changes, and reading
 * it is synchronous in call sites that cannot await.
 */
export function getWorldCanvasId(): string | null {
  return materializesWorkspaces() ? diskWorldCanvasId() : activeWorldCanvasId;
}

export function requireWorldCanvasId(): string {
  const canvasId = getWorldCanvasId();
  if (!canvasId) {
    throw new Error('Configured workspace has no World canvas');
  }
  return canvasId;
}

export function isWorldCanvasId(canvasId: string): boolean {
  const world = getWorldCanvasId();
  return world !== null && world === canvasId;
}

export function getStorage(): Storage {
  return ensure();
}

/**
 * Close the process's storage connections and forget them.
 *
 * Registered on graceful Server shutdown. Disk holds nothing a process exit
 * would not release, so today this is close to a no-op — which is exactly why
 * it has to exist before a connection-holding backend does: a pool that is
 * never closed leaks on every restart, and the place to notice that is the
 * lifecycle, not the adapter.
 *
 * Idempotent and safe before {@link initStorage}: shutdown must not depend on
 * whether anything ever reached for storage.
 */
export async function closeStorage(): Promise<void> {
  const storage = current;
  const connection = sqlite;
  current = null;
  workspaces = null;
  sqlite = null;
  activeWorldCanvasId = null;
  if (storage) {
    await Promise.all([storage.structured.close(), storage.blobs.close()]);
  }
  // The shared connection outlives either store, so closing it is this
  // module's job rather than whichever adapter happens to hold it.
  connection?.close();
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
      // Where the record is a row, nothing else will ever remove the
      // directory those areas sat in. Sweeping the areas is the port's
      // contract; removing what composition placed them under is this
      // module's, and it is what stops a deleted Space leaving a husk behind.
      if (storage.profile.structured.kind !== 'disk') {
        await rm(detachedSpaceRoot(canvasId), {
          recursive: true,
          force: true,
        });
      }
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
  const workspaceKey = activeWorkspaceKey();

  async function requireSpace(): Promise<void> {
    const record = await storage.structured.space(canvasId).read();
    if (!record) {
      throw new Error(`Cannot write blobs for missing Space "${canvasId}"`);
    }
  }

  return {
    async put(name: string, body: Readable | Buffer): Promise<BlobInfo> {
      try {
        return await withSpacePutAdmission(workspaceKey, canvasId, async () => {
          assertActiveWorkspace(workspaceKey, canvasId);
          await requireSpace();
          assertActiveWorkspace(workspaceKey, canvasId);
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
