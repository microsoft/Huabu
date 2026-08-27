// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-canvas storage facade. One instance per `<canvasDir>/`.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { coalesceChanges } from '@huabu/shared/canvas-engine';

import {
  captureNodeTombstones,
  clearNodeTombstone,
  clearSpaceNodeTombstones,
  isNodeTombstoned,
  markNodeDeleted,
  restoreNodeTombstones,
} from './node-tombstones.js';
import {
  appendJsonLine,
  appendJsonLines,
  atomicWriteJson,
  atomicWriteText,
  mapWithConcurrency,
  mkdirp,
  readJson,
  readJsonLines,
  readText,
  readTextAsync,
  sanitizeId,
} from '../../../../../utils/fs.js';
import { getLogger } from '../../../../../utils/logger.js';
import {
  parseFrontmatter,
  toFrontmatter,
} from '../../../../../utils/markdown-frontmatter.js';
import { toSafeFilename } from '../../../../../utils/naming.js';
import { getWorkspacePath } from '../../../../workspace.js';
import { assertSpaceMutationAllowed } from '../../../space-lifecycle-admission.js';
import {
  patchCanvasDirTitle,
  refreshCanvasDirIndex,
  registerCanvasDir,
  renameCanvasDirOnDisk,
  isWorldCanvasId,
  unregisterCanvasDir,
} from '../canvas-dirs.js';
import {
  canvasJsonPath,
  canvasRoot,
  changesPath,
  chatDir,
  deltaLogPath,
  eventsPath,
  nodeFilePath,
  nodesDir,
} from '../layout.js';
import { NameIndex } from '../name-index.js';
import { readValidCanvasFile } from '../space-record-validation.js';
import { titleVisibleAtDirectory } from '../space-title.js';

import type {
  CanvasEvent,
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../../canvas/persistence-types.js';
import type { RecentAction } from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

export type {
  CanvasEvent,
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../../canvas/persistence-types.js';

const log = getLogger('canvas-store');

interface NodeFileEntry {
  id: string;
  filename: string;
}

export type RenameResult =
  | {
      ok: true;
      /** Filesystem-safe filename (`safe(label) [(N)].md`). */
      filename: string;
      /**
       * The label as actually persisted to the markdown frontmatter — the
       * caller-provided label with any dedupe suffix (e.g. ` (2)`) appended
       * but with all original punctuation / non-ASCII characters preserved.
       * Mirror this back into `data.label` on the canvas so the runtime
       * label matches the frontmatter (which is the source of truth).
       */
      label: string | null;
    }
  | {
      ok: false;
      reason: 'conflict';
      conflictWith: { id: string; filename: string };
    }
  | {
      ok: false;
      reason: 'duplicate';
      /** All sidecar filenames currently claiming this nodeId on disk. */
      files: string[];
    }
  | { ok: false; reason: 'not-found' };

export type RenameSelfResult =
  | { ok: true; dirName: string }
  | { ok: false; reason: 'conflict'; conflictWith: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'fs-error'; message: string };

/**
 * Thrown by {@link CanvasStore} mutators when a filesystem operation
 * fails for environmental reasons (ENOSPC, EACCES, EROFS, EXDEV, …).
 *
 * This is intentionally distinct from the structured `{ ok: false }`
 * results that signal *business-level* failures the caller can act on
 * (label conflict, not-found). Filesystem failures cannot be acted on
 * by the caller — they should bubble to the request boundary (HTTP 500
 * / startup abort) and never end up inside an LLM tool transcript.
 */
export class CanvasStoreIOError extends Error {
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'CanvasStoreIOError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Frontmatter keys that older canvases wrote but the current schema no
 * longer recognizes. They are stripped on read so they never round-trip
 * back into a freshly-written file.
 *
 * @deprecated Defensive filter for legacy `nodes/*.md` files.
 *  - `content_hash`: previously used to dedupe extraction work; we now
 *    compare canonical content directly in `persist.ts`.
 *  - `meta_json`:    previously a JSON-stringified bag of summary /
 *    keywords / etc.; those fields are now stored as flat top-level
 *    YAML keys.
 */
const LEGACY_FRONTMATTER_KEYS = ['content_hash', 'meta_json'] as const;

function nodeContentToMarkdown(c: NodeContent): string {
  // `nodeId` is the stable identifier; we explicitly inject it as the
  // frontmatter `id:` field so the on-disk filename (which is derived
  // from the user-facing label and may collide / be deduped) can always
  // be mapped back to the canonical id by `nodeIndex()`. `content` is
  // the markdown body. Everything else lives in the frontmatter as
  // native YAML.
  const { nodeId, content, ...frontmatter } = c;
  const fm: Record<string, unknown> = { id: nodeId, ...frontmatter };
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete fm[key];
  }
  // Drop nullish frontmatter entries so optional fields (e.g. `src` on
  // note/text/frame nodes) never serialize to `key: null`.
  for (const key of Object.keys(fm)) {
    const v = fm[key];
    if (v === null || v === undefined) {
      delete fm[key];
    }
  }
  return `${toFrontmatter(fm)}\n${content}`;
}

function markdownToNodeContent(
  nodeId: string,
  raw: string,
  strict = false,
): NodeContent {
  const { meta, content } = parseFrontmatter(raw, { strict });
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete meta[key];
  }
  // Backward compat: pre-rename files wrote `title:`. Read either, but
  // strip `title` from the frontmatter bag so it never round-trips back.
  const labelMeta =
    typeof meta['label'] === 'string'
      ? meta['label']
      : typeof meta['title'] === 'string'
        ? meta['title']
        : null;
  delete meta['title'];
  delete meta['label'];
  // Drop the synthetic `id` we used to write into frontmatter — the canonical
  // id is the function argument (derived from filename / index).
  delete meta['id'];
  const out: NodeContent = {
    ...meta,
    nodeId,
    type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
    label: labelMeta,
    content,
  };
  // Normalize `src`: it must be a string when present, otherwise omitted.
  if (typeof out.src !== 'string') {
    delete out.src;
  }
  return out;
}

/**
 * Filename for a node's markdown. Frame and other label-less nodes
 * fall back to the stable id so two nodes never collide on a default.
 */
function nodeFilenameFor(nodeId: string, label: string | null): string {
  return `${toSafeFilename(label, nodeId)}.md`;
}

// ─── CanvasStore ────────────────────────────────────────────────────────────

/**
 * Upper bound on concurrent `nodes/*.md` reads in {@link
 * CanvasStore.readAllNodes}. Caps in-flight promises (and therefore peak
 * memory + open file descriptors) while still overlapping I/O so large
 * canvases hydrate faster than the previous serial-synchronous scan.
 */
const NODE_READ_CONCURRENCY = 32;

function toErrnoString(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    if (e.code) return `${e.code}: ${e.message ?? ''}`.trim();
    if (e.message) return e.message;
  }
  return String(err);
}

/**
 * Add a sidecar `<id, filename>` entry to the per-canvas index during a
 * directory scan. Records the `id` into `duplicates` and loudly warns
 * when the same `id` is seen in more than one file (orphan caused by a
 * failed rename in a previous session) so the operator — and the
 * access-time guard in {@link CanvasStore.writeNode} / readers — can
 * surface it; the surviving index entry is whichever the scan visited
 * last, matching the legacy upsert semantics of `NameIndex.put`.
 */
function addSidecarToIndex(
  idx: NameIndex<NodeFileEntry>,
  duplicates: Set<string>,
  canvasId: string,
  id: string,
  filename: string,
): void {
  const existing = idx.get(id);
  if (existing && existing.filename !== filename) {
    duplicates.add(id);
    log.warn(
      { canvasId, nodeId: id, kept: filename, conflicting: existing.filename },
      `duplicate node sidecar for id ${id} in canvas ${canvasId}: ` +
        `"${existing.filename}" vs "${filename}" — keeping "${filename}". ` +
        `delete the stale file manually after confirming which one is current.`,
    );
  }
  idx.add({ id, filename });
}

/**
 * How a directory scan of `nodes/*.md` treats a file it cannot use.
 *
 * The two axes are separate because reachability and content are separate
 * failures, and the readers that want one do not all want the other. A scan
 * that conflated them would force the portable repository to choose between
 * hiding an I/O error and rejecting a sidecar its own single read repairs.
 */
export interface NodeScanOptions {
  /**
   * Reject an unreadable sidecar (EACCES, EIO, a directory in the way)
   * instead of dropping it from the scan. Absence — ENOENT — is still
   * absence. Matches {@link CanvasStore.readNodeStrict}, so a scan and a
   * single read agree about which nodes exist.
   */
  strict?: boolean;
  /**
   * Reject a sidecar whose frontmatter does not parse. Defaults to
   * {@link strict}.
   *
   * The portable node repository sets it `false`: `readNodeStrict` recovers a
   * hand-broken sidecar on purpose — the body survives, the unparseable
   * frontmatter is dropped — so a scan that rejected what a read repairs
   * would make the two shapes disagree about the same node. Readers that
   * treat malformed content as an integrity failure (the World reference
   * resolver, the Space preview) leave it defaulted.
   */
  strictRecords?: boolean;
}

/**
 * Read one node sidecar under either compatibility or repository semantics.
 * Compatibility readers preserve the legacy "missing or unreadable" `null`
 * while retaining whether that answer proves absence. Strict repository reads
 * treat only ENOENT as absence so a failed ownership scan cannot authorize a
 * create over durable bytes it could not inspect.
 */
function readNodeSidecar(
  filePath: string,
  strict: boolean,
): { raw: string | null; conclusive: boolean } {
  try {
    return { raw: readFileSync(filePath, 'utf8'), conclusive: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { raw: null, conclusive: true };
    }
    if (!strict) return { raw: null, conclusive: false };
    throw error;
  }
}

export class CanvasStore {
  readonly canvasId: string;
  /** Workspace this handle was created for; handles never follow activation. */
  readonly #workspacePath: string;
  private nodes: NameIndex<NodeFileEntry> | null = null;
  /** Whether the cached index was built without swallowing sidecar failures. */
  private nodeIndexIsConclusive = false;
  /** Invalidates stale async batch scans without serializing their I/O. */
  private nodeIndexGeneration = 0;
  /**
   * Ids that resolve to more than one `.md` sidecar on disk, captured
   * during the most recent index scan. Kept in sync with {@link nodes}:
   * every rebuild reassigns both. Consumed by the access-time duplicate
   * guard so reads/writes of an affected node can surface the conflict
   * instead of silently picking one file.
   */
  private nodeDuplicateIds = new Set<string>();
  /**
   * Synchronous executor batches validate the aggregate once before touching
   * several sidecars. Only node guards consult this depth; the callback never
   * escapes and standalone mutations still perform their own strict read.
   */
  private nodeMutationTransactionDepth = 0;
  /** INSERT ids allowed to rewrite a still-tombstoned sidecar in this commit. */
  private tombstoneInsertBypassNodeIds: ReadonlySet<string> | null = null;
  /** Live ids from the latest structural write, reconciled after log commit. */
  private deferredTombstoneReconciliationNodeIds: Set<string> | null = null;

  constructor(canvasId: string, workspacePath = getWorkspacePath()) {
    this.canvasId = sanitizeId(canvasId, 'canvasId');
    this.#workspacePath = path.resolve(workspacePath);
  }

  /**
   * A cached handle is scoped to the workspace that created it. Without this
   * guard, a caller retaining a handle across `setWorkspacePath()` would send
   * its cached node filename/index state into the newly-active workspace.
   */
  private assertActiveWorkspace(): void {
    const active = path.resolve(getWorkspacePath());
    if (active !== this.#workspacePath) {
      throw new Error(
        `CanvasStore(${this.canvasId}) belongs to an inactive workspace. ` +
          `Resolve a fresh Space handle after workspace activation.`,
      );
    }
  }

  // ── Canvas structure ─────────────────────────────────────────────────────

  /**
   * Read this Space's `space.json`. When the on-disk directory name
   * cannot be derived from the persisted title via {@link toSafeFilename}
   * we treat that as a Finder-side rename and adopt `dirName` as the new
   * title (persisted back into `space.json`). The common case where
   * `dirName === safe(title)` (e.g. title contains `?` / `:` / `/` that
   * was sanitised at create time) is left alone — overwriting there
   * would silently strip the user's typed characters from the title.
   */
  read(): CanvasFile | null {
    this.assertActiveWorkspace();
    let file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
    if (!file) {
      refreshCanvasDirIndex();
      file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
      if (!file) return null;
    }

    return this.reconcileValidatedRecord(file);
  }

  /** @internal Apply legacy Finder-title semantics without rereading disk. */
  reconcileValidatedRecord(file: CanvasFile): CanvasFile {
    this.assertActiveWorkspace();
    if (file.canvasId !== this.canvasId) {
      throw new Error(
        `CanvasStore(${this.canvasId}) cannot reconcile record "${file.canvasId}"`,
      );
    }
    const dirName = path.basename(canvasRoot(this.canvasId));
    const visibleTitle = titleVisibleAtDirectory(
      file.title,
      this.canvasId,
      dirName,
    );
    if (!isWorldCanvasId(this.canvasId) && visibleTitle !== file.title) {
      const next: CanvasFile = {
        ...file,
        title: visibleTitle,
        updatedAt: Date.now(),
      };
      try {
        assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
        atomicWriteJson(canvasJsonPath(this.canvasId), next);
        patchCanvasDirTitle(this.canvasId, visibleTitle);
        return next;
      } catch {
        return { ...file, title: visibleTitle };
      }
    }

    return file;
  }

  write(canvas: CanvasFile): void {
    this.writeRecord(canvas, true);
  }

  /** @internal Executor rollback: restore bytes without tombstone inference. */
  writeNodeMutationRollback(canvas: CanvasFile): void {
    this.writeRecord(canvas, false);
  }

  private writeRecord(canvas: CanvasFile, reconcileTombstones: boolean): void {
    this.assertActiveWorkspace();
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
    if (canvas.canvasId !== this.canvasId) {
      throw new Error(
        `CanvasStore(${this.canvasId}) refusing to write canvas with id "${canvas.canvasId}"`,
      );
    }

    const liveNodeIds = new Set<string>();
    for (const n of canvas.state.nodes) {
      const id = (n as { id?: unknown } | null)?.id;
      if (typeof id === 'string') liveNodeIds.add(id);
    }
    const reconcileNodeIds = new Set<string>();
    if (reconcileTombstones) {
      const tombstonedLiveIds = [...liveNodeIds].filter((id) =>
        isNodeTombstoned(this.#workspacePath, this.canvasId, id),
      );
      if (tombstonedLiveIds.length > 0) {
        const previous = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
        const previousNodeIds = new Set<string>();
        if (Array.isArray(previous?.state?.nodes)) {
          for (const node of previous.state.nodes) {
            const id = (node as { id?: unknown } | null)?.id;
            if (typeof id === 'string') previousNodeIds.add(id);
          }
        }
        for (const id of tombstonedLiveIds) {
          if (
            !previousNodeIds.has(id) ||
            this.tombstoneInsertBypassNodeIds?.has(id)
          ) {
            reconcileNodeIds.add(id);
          }
        }
      }
    }

    atomicWriteJson(canvasJsonPath(this.canvasId), canvas);
    // Only an absent→present transition (or the transaction's authoritative
    // INSERT) proves resurrection. Retaining a still-listed id is the normal
    // delete-before-autosave window and must not clear its late-write guard.
    if (this.nodeMutationTransactionDepth > 0) {
      this.deferredTombstoneReconciliationNodeIds = reconcileNodeIds;
      return;
    }
    for (const id of reconcileNodeIds) {
      clearNodeTombstone(this.#workspacePath, this.canvasId, id);
    }
  }

  /**
   * Validate the aggregate record before a node mutation can create, remove,
   * or index sidecar paths. A missing indexed path gets one directory-index
   * refresh for Finder rename recovery; invalid present bytes fail before
   * the legacy reader can self-heal and rewrite them.
   */
  private readValidSpaceForMutation(operation: string): CanvasFile | null {
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
    try {
      let record = readValidCanvasFile(
        canvasJsonPath(this.canvasId),
        this.canvasId,
      );
      if (!record) {
        refreshCanvasDirIndex();
        record = readValidCanvasFile(
          canvasJsonPath(this.canvasId),
          this.canvasId,
        );
      }
      if (!record) return null;
      return this.reconcileValidatedRecord(record);
    } catch (error) {
      throw new CanvasStoreIOError(
        `Cannot ${operation} because Space ${this.canvasId} has an unreadable space.json`,
        { cause: error },
      );
    }
  }

  private requireExistingSpaceForMutation(operation: string): void {
    if (this.nodeMutationTransactionDepth > 0) {
      assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
      return;
    }
    const record = this.readValidSpaceForMutation(operation);
    if (!record) {
      throw new CanvasStoreIOError(
        `Cannot ${operation} because Space ${this.canvasId} does not exist`,
      );
    }
  }

  /**
   * Run one synchronous executor sidecar batch behind a single strict
   * `space.json` validation.
   *
   * @internal This is deliberately absent from the storage ports and runtime
   * facade. The executor already owns the Space mutex and performs all of its
   * sidecar mutations without yielding, so the validated record cannot change
   * between this check and the guarded writes/deletes in the callback.
   */
  withValidatedNodeMutationTransaction<T>(
    options: {
      affectedNodeIds: ReadonlySet<string>;
      insertedNodeIds: ReadonlySet<string>;
    },
    callback: () => T,
  ): T {
    this.assertActiveWorkspace();
    if (this.nodeMutationTransactionDepth > 0) {
      throw new Error('CanvasStore node mutation transactions cannot nest');
    }
    if (!this.readValidSpaceForMutation('mutate node content')) {
      throw new CanvasStoreIOError(
        `Cannot mutate node content because Space ${this.canvasId} does not exist`,
      );
    }

    // Physical node ownership is established by {@link writeNode}'s own
    // staleness probes, which run per mutation inside this batch. Forcing a
    // rescan here instead would make every executor batch read and parse
    // every sidecar in the Space — O(nodes) synchronous I/O inside the canvas
    // mutex, on the hottest write path there is.

    const tombstoneSnapshot = captureNodeTombstones(
      this.#workspacePath,
      this.canvasId,
      options.affectedNodeIds,
    );
    this.nodeMutationTransactionDepth = 1;
    this.tombstoneInsertBypassNodeIds = options.insertedNodeIds;
    this.deferredTombstoneReconciliationNodeIds = new Set();
    try {
      const result = callback();
      // `callback` includes the structural write and delta-log append. Only
      // after both return successfully may a listed id clear its tombstone.
      for (const id of this.deferredTombstoneReconciliationNodeIds) {
        clearNodeTombstone(this.#workspacePath, this.canvasId, id);
      }
      return result;
    } catch (error) {
      restoreNodeTombstones(
        this.#workspacePath,
        this.canvasId,
        tombstoneSnapshot,
      );
      throw error;
    } finally {
      this.deferredTombstoneReconciliationNodeIds = null;
      this.tombstoneInsertBypassNodeIds = null;
      this.nodeMutationTransactionDepth = 0;
    }
  }

  /**
   * Strict directory rename. Returns a structured conflict instead of
   * throwing so the route layer can map it to a 409.
   */
  renameSelf(newTitle: string | null): RenameSelfResult {
    this.assertActiveWorkspace();
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
    if (isWorldCanvasId(this.canvasId)) {
      return { ok: false, reason: 'forbidden' };
    }
    const desired = toSafeFilename(newTitle, this.canvasId);
    if (!existsSync(canvasRoot(this.canvasId))) {
      return { ok: false, reason: 'not-found' };
    }

    const result = renameCanvasDirOnDisk(this.canvasId, desired);
    if (result.ok) {
      patchCanvasDirTitle(this.canvasId, newTitle);
      return { ok: true, dirName: result.dirName };
    }
    if (result.reason === 'not-found') {
      const current = path.basename(canvasRoot(this.canvasId));
      registerCanvasDir(this.canvasId, current, newTitle);
      return this.renameSelf(newTitle);
    }
    if (result.reason === 'conflict') {
      return {
        ok: false,
        reason: 'conflict',
        conflictWith: result.conflictWith,
      };
    }
    return { ok: false, reason: 'fs-error', message: result.message };
  }

  // ── Node content ─────────────────────────────────────────────────────────

  private nodeIndex(strict = false): NameIndex<NodeFileEntry> {
    if (this.nodes && (!strict || this.nodeIndexIsConclusive)) {
      return this.nodes;
    }
    if (strict) {
      // A lenient compatibility scan may have skipped an unreadable sidecar.
      // Invalidate it before a repository read relies on physical ownership.
      // This also prevents an older asynchronous batch scan from replacing the
      // strict result after it completes.
      this.invalidateNodeIndex();
    }
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
    let indexIsConclusive = true;
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const read = readNodeSidecar(path.join(dir, file), strict);
        if (!read.conclusive) indexIsConclusive = false;
        const { raw } = read;
        if (raw == null) continue;
        const { meta } = parseFrontmatter(raw);
        const rawId = meta['id'];
        const id =
          typeof rawId === 'string' && rawId
            ? rawId
            : file.replace(/\.md$/, '');
        addSidecarToIndex(idx, duplicates, this.canvasId, id, file);
      }
    }
    this.nodes = idx;
    this.nodeIndexIsConclusive = indexIsConclusive;
    this.nodeDuplicateIds = duplicates;
    return idx;
  }

  private invalidateNodeIndex(): void {
    this.nodes = null;
    this.nodeIndexIsConclusive = false;
    this.nodeIndexGeneration += 1;
  }

  /**
   * Reconcile the cached node index against disk for a single-node read
   * (the manual-refresh path), dropping the cache only when a rescan is
   * actually warranted. Two triggers force the drop:
   *
   *   1. `nodeId` is currently flagged duplicate. The cheap filename probe
   *      below can't see a duplicate being *resolved*: while duplicated,
   *      the index collapses the two sidecars to one id, so deleting one
   *      file makes the on-disk `.md` count match the cached index size
   *      again (1 === 1) and the probe reads "fresh". A flagged node
   *      therefore always re-reads so the resolution is detected.
   *   2. the on-disk `.md` filename set drifted from the cached index — a
   *      sibling sidecar appeared, vanished, or was replaced since the last
   *      scan (e.g. a new duplicate or another store instance's write).
   *
   * A strict repository read additionally upgrades a cache built by a
   * lenient compatibility scan before applying these probes, because that
   * scan may have omitted an unreadable physical owner.
   *
   * Otherwise the warm cache is trusted. The probe is a names-only
   * `readdir`; per-file contents are only re-read when a rescan fires.
   */
  revalidateNodeForRead(nodeId: string, strict = false): void {
    this.assertActiveWorkspace();
    const idx = this.nodeIndex(strict);
    if (this.nodeDuplicateIds.has(nodeId) || this.nodeIndexCountStale(idx)) {
      this.invalidateNodeIndex();
    }
  }

  /**
   * True when more than one `.md` sidecar currently claims `nodeId`.
   * Ensures the index has been scanned (so the duplicate set reflects the
   * last disk read) before answering. Cheap on a warm cache; consumers on
   * the hydrate path call it after {@link readAllNodes} has already
   * populated the set, so no extra scan happens there.
   */
  isDuplicateNode(nodeId: string): boolean {
    this.assertActiveWorkspace();
    this.nodeIndex();
    return this.nodeDuplicateIds.has(nodeId);
  }

  /**
   * Disk-truth list of every sidecar filename currently claiming
   * `nodeId`. Public surface for the hydrate / reveal paths so the
   * client can show the user exactly which files collide and let them
   * pick one to keep. Returns `[]` when the node is not duplicated.
   * O(directory size) — only called on the rare duplicate path.
   */
  duplicateNodeFiles(nodeId: string): string[] {
    this.assertActiveWorkspace();
    return this.duplicateNodeFilenames(nodeId);
  }

  /**
   * Cheap staleness probe: compare the `.md` filenames currently on disk
   * against the cached index. A names-only `readdirSync` (no file contents
   * read) notices appearances, removals, renames, and equal-count
   * replacements before a write trusts cached physical ownership.
   */
  private nodeIndexCountStale(idx: NameIndex<NodeFileEntry>): boolean {
    const dir = nodesDir(this.canvasId);
    if (!existsSync(dir)) return idx.size() > 0;
    const diskFiles = readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort();
    const indexedFiles = idx
      .list()
      .map((entry) => entry.filename)
      .sort();
    return (
      diskFiles.length !== indexedFiles.length ||
      diskFiles.some((file, index) => file !== indexedFiles[index])
    );
  }

  /**
   * Disk-truth list of every sidecar filename that resolves to `nodeId`.
   * O(directory size); only called on the rare duplicate-resolution path
   * (e.g. building the error surfaced to the user), never on hot writes.
   */
  private duplicateNodeFilenames(nodeId: string): string[] {
    const dir = nodesDir(this.canvasId);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const raw = readText(path.join(dir, file));
      if (raw == null) continue;
      const { meta } = parseFrontmatter(raw);
      const rawId = meta['id'];
      const id =
        typeof rawId === 'string' && rawId ? rawId : file.replace(/\.md$/, '');
      if (id === nodeId) out.push(file);
    }
    return out;
  }

  /**
   * Unlink with a few immediate retries to ride out an ultra-transient
   * lock (Windows `EPERM` / `EBUSY` from AV or a file watcher). Stays
   * synchronous on purpose — {@link writeNode} must not become async, so
   * we never sleep between attempts. If the file is already gone we treat
   * it as success; otherwise we report the last error to the caller,
   * which decides how to roll back.
   */
  private tryUnlink(
    filePath: string,
  ): { ok: true } | { ok: false; error: unknown } {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        unlinkSync(filePath);
        return { ok: true };
      } catch (err) {
        if (!existsSync(filePath)) return { ok: true };
        lastError = err;
      }
    }
    return { ok: false, error: lastError };
  }

  private nodeFilenameOf(nodeId: string): string {
    const entry = this.nodeIndex().get(nodeId);
    return entry?.filename ?? `${sanitizeId(nodeId, 'nodeId')}.md`;
  }

  /**
   * Reverse of {@link nodeFilenameOf}: resolve a sidecar `filename`
   * (basename, e.g. `My note.md`) back to the node id that currently owns
   * it, or `null` when no sidecar claims that name. Backed by the same
   * frontmatter-`id` index, so it is correct even when the filename does
   * not match `toSafeFilename(label)` (dedupe suffixes, external renames).
   */
  nodeIdForFilename(filename: string): string | null {
    this.assertActiveWorkspace();
    return this.nodeIndex().findByName(filename)?.id ?? null;
  }

  readNode(nodeId: string): NodeContent | null {
    this.assertActiveWorkspace();
    const filename = this.nodeFilenameOf(nodeId);
    const fullPath = nodeFilePath(this.canvasId, filename);
    let raw = readText(fullPath);
    if (raw === null) {
      this.invalidateNodeIndex();
      const retryFilename = this.nodeFilenameOf(nodeId);
      if (retryFilename !== filename) {
        raw = readText(nodeFilePath(this.canvasId, retryFilename));
      }
      if (raw === null) return null;
    }
    return markdownToNodeContent(nodeId, raw);
  }

  /**
   * Single-record read for the backend-neutral repository.
   *
   * Strict about *reachability*, not about content. Compatibility reads
   * collapse every failure into `null`; this one treats only ENOENT as
   * absence, so an unreadable sidecar (EACCES, EIO, a directory in the way)
   * surfaces instead of being reported as a missing node.
   *
   * Malformed frontmatter is deliberately **not** a read failure. A sidecar
   * is a hand-editable file, and a node whose YAML a user broke must stay
   * repairable: rejecting the read here would make that node uneditable
   * through the content PUT and undeletable through the DELETE route, while
   * the lenient GET kept rendering it. Recovery matches {@link readNode} —
   * the body survives and the unparseable frontmatter is dropped.
   *
   * Duplicate sidecars remain readable through the selected representative;
   * the following repository `put` reports the existing actionable duplicate
   * outcome instead of overwriting either file.
   */
  readNodeStrict(nodeId: string): NodeContent | null {
    this.assertActiveWorkspace();
    this.revalidateNodeForRead(nodeId, true);

    const read = (filename: string): string | null =>
      readNodeSidecar(nodeFilePath(this.canvasId, filename), true).raw;

    const readOwned = (filename: string): string | null => {
      const raw = read(filename);
      if (raw === null) return null;
      // Same lenient parse the index itself uses, so ownership resolves the
      // same way for a broken sidecar as it does during a scan.
      const { meta } = parseFrontmatter(raw);
      const rawId = meta['id'];
      const persistedId =
        typeof rawId === 'string' && rawId
          ? rawId
          : filename.replace(/\.md$/, '');
      return persistedId === nodeId ? raw : null;
    };

    let filename = this.nodeIndex(true).get(nodeId)?.filename;
    if (filename === undefined) {
      // A warm filename cache cannot detect an in-place frontmatter id edit.
      // Rebuild content ownership before declaring a stable id absent.
      this.invalidateNodeIndex();
      filename = this.nodeIndex(true).get(nodeId)?.filename;
      if (filename === undefined) return null;
    }
    let raw = readOwned(filename);
    if (raw === null) {
      this.invalidateNodeIndex();
      const retryFilename = this.nodeIndex(true).get(nodeId)?.filename;
      if (retryFilename === undefined) return null;
      filename = retryFilename;
      raw = readOwned(filename);
      if (raw === null) return null;
    }
    return markdownToNodeContent(nodeId, raw);
  }

  /**
   * One-pass batch read of every node's markdown sidecar. Returns a
   * `Map<nodeId, NodeContent>` so the canvas GET route can hydrate the
   * full node list with a single `readdirSync` + one `readText` per
   * file, instead of the N+1 pattern (`nodeIndex` scan reads every file
   * once to build the id index, then `readNode` reads each file again
   * to get the body). Also primes the in-memory `nodeIndex` cache as a
   * side-effect so any follow-up `readNode` / `writeNode` in the same
   * request skips a re-scan.
   *
   * Only used on the batch hydrate path — single-node lookups should
   * continue to call `readNode(nodeId)`.
   *
   * Defaults to the legacy compatibility semantics: a sidecar that cannot be
   * read is dropped and the index it primes is marked inconclusive. See
   * {@link NodeScanOptions} for the strict variants the portable repository
   * and the integrity-sensitive readers ask for.
   *
   * Reads run concurrently (bounded by {@link NODE_READ_CONCURRENCY})
   * via async, non-blocking `readFile` calls so the event loop stays
   * free and large canvases hydrate with overlapped I/O. The id index
   * is still built in stable `readdirSync` order so the derived keys
   * match the previous synchronous implementation exactly.
   */
  async readAllNodes(
    options?: NodeScanOptions,
  ): Promise<Map<string, NodeContent>> {
    this.assertActiveWorkspace();
    const strictRecords = options?.strictRecords ?? options?.strict ?? false;
    const generation = this.nodeIndexGeneration;
    const contents = new Map<string, NodeContent>();
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
    let indexIsConclusive = true;
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((file) => file.endsWith('.md'));
      const raws = await mapWithConcurrency(
        files,
        NODE_READ_CONCURRENCY,
        (file) =>
          options?.strict
            ? readFile(path.join(dir, file), 'utf8')
            : readTextAsync(path.join(dir, file)),
      );
      for (let i = 0; i < files.length; i++) {
        const raw = raws[i];
        if (raw === null) {
          indexIsConclusive = false;
          continue;
        }
        const file = files[i];
        // Mirror `nodeIndex()`'s id derivation so the keys in the
        // returned map align 1:1 with what `readNode(nodeId)` would
        // resolve to. Frontmatter `id` wins; fall back to the
        // filename-without-extension exactly like the index does.
        const { meta } = parseFrontmatter(raw);
        const rawId = meta['id'];
        const id =
          typeof rawId === 'string' && rawId
            ? rawId
            : file.replace(/\.md$/, '');
        addSidecarToIndex(idx, duplicates, this.canvasId, id, file);
        contents.set(id, markdownToNodeContent(id, raw, strictRecords));
      }
    }
    if (this.nodeIndexGeneration === generation) {
      this.nodes = idx;
      this.nodeIndexIsConclusive = indexIsConclusive;
      this.nodeDuplicateIds = duplicates;
    }
    return contents;
  }

  /**
   * Streaming variant of {@link readAllNodes}: invokes `onNode(id, content)`
   * synchronously each time a sidecar finishes reading and parsing, while
   * the remaining files continue to load concurrently. Returns the full
   * map once every file has been processed, identical to `readAllNodes`,
   * so the caller can do a follow-up batch scan without re-hitting disk.
   *
   * Useful for the canvas search route: the metadata tier can emit
   * matches as each `.md` lands rather than waiting for the full
   * `readdir` + `mapWithConcurrency` round-trip to settle.
   *
   * `signal` is polled inside each worker before issuing the file read;
   * workers that observe an aborted signal exit early without touching
   * disk. The shared cursor still drains so the returned `Promise`
   * always resolves (callers should check `signal.aborted` themselves
   * and ignore the result).
   *
   * Concurrency bound is the same {@link NODE_READ_CONCURRENCY} the
   * non-streaming path uses, so memory / FD pressure is identical.
   *
   * Takes the same {@link NodeScanOptions} as {@link readAllNodes}, and with
   * the same defaults. A strict scan rejects rather than returning a silently
   * short collection: the first unreadable sidecar stops the remaining
   * workers from starting, and the failure is raised once every in-flight
   * read has settled. `onNode` may already have fired for the files that
   * landed before the failure — a partial delivery is unavoidable — but never
   * after the caller has been told the scan failed, which is the part a
   * caller cannot defend against itself.
   */
  async streamAllNodes(
    onNode: (id: string, content: NodeContent) => void,
    signal?: { readonly aborted: boolean },
    options?: NodeScanOptions,
  ): Promise<Map<string, NodeContent>> {
    this.assertActiveWorkspace();
    const strictRecords = options?.strictRecords ?? options?.strict ?? false;
    const generation = this.nodeIndexGeneration;
    const contents = new Map<string, NodeContent>();
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
    let indexIsConclusive = true;
    // The first strict failure, raised after the fan-out settles. Throwing
    // from inside a worker would reject while its siblings were still
    // delivering, so a caller could receive nodes after it had already been
    // handed the error. Only a strict scan ever sets it; `onNode` is left
    // outside the guard so a caller's own throw propagates as it always has.
    const scan: { failure: { readonly error: unknown } | null } = {
      failure: null,
    };
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((file) => file.endsWith('.md'));
      await mapWithConcurrency(files, NODE_READ_CONCURRENCY, async (file) => {
        if (signal?.aborted || scan.failure !== null) {
          indexIsConclusive = false;
          return;
        }
        let raw: string | null;
        try {
          raw = options?.strict
            ? await readFile(path.join(dir, file), 'utf8')
            : await readTextAsync(path.join(dir, file));
        } catch (error) {
          scan.failure ??= { error };
          indexIsConclusive = false;
          return;
        }
        if (raw === null) {
          indexIsConclusive = false;
          return;
        }
        // Same id derivation as `readAllNodes()` / `nodeIndex()`.
        const { meta } = parseFrontmatter(raw);
        const rawId = meta['id'];
        const id =
          typeof rawId === 'string' && rawId
            ? rawId
            : file.replace(/\.md$/, '');
        addSidecarToIndex(idx, duplicates, this.canvasId, id, file);
        let content: NodeContent;
        try {
          content = markdownToNodeContent(id, raw, strictRecords);
        } catch (error) {
          scan.failure ??= { error };
          indexIsConclusive = false;
          return;
        }
        contents.set(id, content);
        // JS is single-threaded between awaits, so even though
        // multiple workers may be in-flight, exactly one onNode call
        // runs at a time. Callers can mutate shared counters safely.
        onNode(id, content);
      });
      if (scan.failure !== null) throw scan.failure.error;
    }
    if (this.nodeIndexGeneration === generation) {
      this.nodes = idx;
      this.nodeIndexIsConclusive = indexIsConclusive;
      this.nodeDuplicateIds = duplicates;
    }
    return contents;
  }

  /**
   * Write a node's markdown. Strict mode refuses sibling-label
   * collisions; lazy mode auto-dedupes with `(2)` / `(3)` suffixes.
   */
  writeNode(
    nodeId: string,
    content: NodeContent,
    opts: { strictRename?: boolean } = {},
  ): RenameResult {
    this.assertActiveWorkspace();
    if (content.nodeId !== nodeId) {
      throw new Error(
        `nodeId mismatch: argument="${nodeId}" payload="${content.nodeId}"`,
      );
    }
    // A node sidecar is part of an existing Space aggregate. Creating its
    // directory before checking `space.json` would leave an orphan Space tree
    // for a typo or stale id.
    if (
      this.nodeMutationTransactionDepth === 0 &&
      !this.readValidSpaceForMutation('write node content')
    ) {
      return { ok: false, reason: 'not-found' };
    }
    mkdirp(nodesDir(this.canvasId));

    let idx = this.nodeIndex();
    let existing = idx.get(nodeId);

    // ── Optimization 1: reconcile the in-memory index against disk before
    // deciding whether this is an edit or a first write. The cached index
    // can drift from disk in several ways — another live CanvasStore
    // instance wrote the sidecar, a concurrent readAllNodes() rebuilt the
    // index, or the file was renamed/moved/deleted outside the app. If we
    // trusted a stale index we could recreate a second sidecar under a
    // fresh name (a duplicate) or rename the wrong file. Two cheap probes
    // decide whether a full content rescan is warranted:
    //   1. the file the index points at for this id is gone, or
    //   2. the on-disk `.md` filename set no longer matches the cached set
    //      (a sibling appeared, vanished, or was replaced externally).
    // Only then do we pay for a rescan, which also refreshes the
    // duplicate-id set consulted by the guard below. Steady-state edits
    // and batch creates skip the rescan and stay on the fast path.
    const knownGone =
      existing != null &&
      !existsSync(nodeFilePath(this.canvasId, existing.filename));
    if (knownGone || this.nodeIndexCountStale(idx)) {
      this.invalidateNodeIndex();
      idx = this.nodeIndex();
      existing = idx.get(nodeId);
    }

    // ── Access-time detection: refuse to write while two sidecars claim
    // this id. Writing now would pick one arbitrarily and risk clobbering
    // the wrong file; surface a hard error so the user resolves the
    // duplicate instead of letting the app silently compound it.
    if (this.nodeDuplicateIds.has(nodeId)) {
      return {
        ok: false,
        reason: 'duplicate',
        files: this.duplicateNodeFilenames(nodeId),
      };
    }

    // Empty / nullish label → fall back to whatever filename is already on
    // disk for this nodeId (don't churn it into `<nodeId>.md`). Only on a
    // genuine first write do we let `nodeFilenameFor` pick the nodeId
    // fallback. This protects the file name from being clobbered by an
    // intermediate save whose `data.label` is briefly empty (e.g. canvas
    // autosave racing with the LLM enrich result).
    const trimmedLabel =
      typeof content.label === 'string' && content.label.trim().length > 0
        ? content.label
        : null;
    const desired =
      trimmedLabel === null && existing
        ? existing.filename
        : nodeFilenameFor(nodeId, trimmedLabel);

    let target = existing?.filename ?? desired;
    if (!existing || existing.filename !== desired) {
      const conflict = idx.findByName(desired);
      if (!conflict || conflict.id === nodeId) {
        target = desired;
      } else if (opts.strictRename) {
        return {
          ok: false,
          reason: 'conflict',
          conflictWith: { id: conflict.id, filename: conflict.filename },
        };
      } else {
        target = idx.suggestUnique(desired, true, nodeId);
      }
    }

    const isRename = !!existing && existing.filename !== target;

    // Compute the dedupe suffix (e.g. ` (2)`) by diffing the desired
    // safe-filename stem against the actual on-disk stem and apply it to
    // the *original* label. The frontmatter `label:` keeps all
    // user-typed punctuation / non-ASCII characters; only the filename
    // gets the sanitised + suffixed form. This way every reader sees
    // `Hello: World? (2)` rather than the safe `Hello_ World_ (2)`.
    const desiredStem = desired.replace(/\.md$/, '');
    const targetStem = target.replace(/\.md$/, '');
    const suffix =
      targetStem.length > desiredStem.length &&
      targetStem.startsWith(desiredStem)
        ? targetStem.slice(desiredStem.length)
        : '';
    const finalLabel =
      suffix && trimmedLabel ? `${trimmedLabel}${suffix}` : trimmedLabel;
    const finalContent: NodeContent =
      suffix && trimmedLabel ? { ...content, label: finalLabel } : content;

    // ── Optimization 2: write-then-swap ordering. Write the new body to
    // the target filename first (atomicWriteText = temp file + atomic
    // rename, which also atomically replaces any existing file at the
    // target). Only after the new file is safely in place do we remove the
    // old sidecar. This guarantees every failure point below leaves the
    // original file (old name + old body) intact and the in-memory idx
    // unchanged, so a caller retry sees a consistent state and we never
    // strand two files claiming this id from a partially-applied rename.
    const newPath = nodeFilePath(this.canvasId, target);

    try {
      atomicWriteText(newPath, nodeContentToMarkdown(finalContent));
    } catch (err) {
      // Nothing has been moved or deleted yet — the original sidecar (if
      // any) is untouched and idx still points at it. Bubble as an
      // environmental error for the caller to retry / surface.
      const message = `Failed to write node content to "${target}": ${toErrnoString(err)}`;
      log.warn({ err, canvasId: this.canvasId, nodeId, target }, message);
      throw new CanvasStoreIOError(message, { cause: err });
    }

    if (isRename) {
      // `isRename` is only true when `existing` is set; the non-null
      // assertion documents that invariant (TS cannot narrow a `let`
      // through the aliased `isRename` boolean).
      const oldFilename = existing!.filename;
      const oldPath = nodeFilePath(this.canvasId, oldFilename);
      const removed = this.tryUnlink(oldPath);
      if (!removed.ok) {
        // Could not delete the old sidecar, so the rename effectively
        // failed and we'd otherwise leave two files claiming this id.
        // Roll back by removing the file we just wrote so the original
        // stays the single source of truth, then surface a hard error to
        // the user — a failed rename should be reported, not hidden. If
        // the rollback unlink ALSO fails (double failure) the duplicate is
        // now persistent: flag the id so the next read/write reports it.
        const rollback = this.tryUnlink(newPath);
        if (!rollback.ok) {
          this.nodeDuplicateIds.add(nodeId);
          this.nodeIndexGeneration += 1;
        }
        const message = `Failed to remove stale node sidecar "${oldFilename}" after writing "${target}": ${toErrnoString(removed.error)}`;
        log.warn(
          {
            err: removed.error,
            canvasId: this.canvasId,
            nodeId,
            from: oldFilename,
            to: target,
          },
          message,
        );
        throw new CanvasStoreIOError(message, { cause: removed.error });
      }
      idx.rename(nodeId, target);
    } else if (!existing) {
      idx.add({ id: nodeId, filename: target });
    }

    this.nodeIndexGeneration += 1;

    return { ok: true, filename: target, label: finalLabel };
  }

  /**
   * Delete a node's markdown sidecar.
   *
   * Returns:
   * - `'deleted'`: the file existed and was successfully unlinked.
   * - `'absent'`: no sidecar on disk to begin with (idempotent success).
   *
   * Throws {@link CanvasStoreIOError} when the file exists but every
   * unlink attempt fails (e.g. Windows `EPERM` from AV / file-watcher,
   * EROFS, EACCES). Like {@link writeNode}'s rename path, the unlink is
   * routed through {@link tryUnlink} so an ultra-transient lock is ridden
   * out with a few immediate retries before we give up. The in-memory
   * NameIndex is left untouched on failure so a retry sees the same
   * state. Callers must let the error bubble — silently swallowing it
   * would leave structural state without a reference to the node while its
   * `.md` stays on disk as a permanent orphan.
   */
  deleteNode(nodeId: string): 'deleted' | 'absent' {
    this.assertActiveWorkspace();
    // Keep idempotent delete semantics, but do not retain a tombstone for an
    // id whose Space itself does not exist.
    if (
      this.nodeMutationTransactionDepth === 0 &&
      !this.readValidSpaceForMutation('delete node content')
    ) {
      return 'absent';
    }
    // A duplicated id deliberately still deletes its indexed representative.
    // Refusing would strand the node: duplicate sidecars are exactly the state
    // a user resolves by deleting, and an executor batch containing such a
    // delete would fail and roll back wholesale.
    //
    // Tombstone the id up front (before any early return or throw) so a late
    // in-flight write cannot resurrect the sidecar regardless of which delete
    // branch we take. The process registry outlives an evicted LRU instance
    // and expires the entry on its own timer.
    markNodeDeleted(this.#workspacePath, this.canvasId, nodeId);

    const idx = this.nodeIndex();
    const filename = idx.get(nodeId)?.filename ?? this.nodeFilenameOf(nodeId);
    const filePath = nodeFilePath(this.canvasId, filename);
    if (!existsSync(filePath)) {
      idx.remove(nodeId);
      this.nodeIndexGeneration += 1;
      return 'absent';
    }
    const removed = this.tryUnlink(filePath);
    if (!removed.ok) {
      const message = `deleteNode unlink failed for ${nodeId} (${filePath}): ${toErrnoString(removed.error)}`;
      log.warn(
        { err: removed.error, canvasId: this.canvasId, nodeId, filePath },
        message,
      );
      throw new CanvasStoreIOError(message, { cause: removed.error });
    }
    idx.remove(nodeId);
    this.nodeIndexGeneration += 1;
    return 'deleted';
  }

  /**
   * Whether a `.md` sidecar write for `nodeId` should be dropped because the
   * node was just deleted and has not come back — the tombstone guard that
   * stops a late in-flight writer (an already-sent content PUT, or a slow
   * preprocessing run that finishes after the DELETE) from recreating a
   * ghost sidecar the external note watcher would surface on the canvas.
   *
   * Suppress only when the id is tombstoned, unexpired, AND absent from the
   * live structural state. Presence in `space.json` is an escape hatch that
   * lets the write through, but it does NOT clear the tombstone: during the
   * delete-before-autosave window the sidecar DELETE has landed while the
   * structural PUT that drops the node is still pending, so the id is
   * transiently still listed. Clearing here would let a later slow in-flight
   * writer resurrect the ghost once that PUT lands. The tombstone is cleared
   * only by a structural {@link write} that re-lists the id (the genuine
   * undo/redo resurrection) or by TTL expiry. Brand-new nodes are never
   * tombstoned, so a first write racing its structural PUT is never
   * suppressed.
   *
   * Called from the Disk node adapter's single-record write funnel. The
   * `read()` cost is paid only for the rare write that targets a
   * recently-deleted id (the common case short-circuits on an empty map).
   */
  isNodeWriteSuppressed(nodeId: string): boolean {
    this.assertActiveWorkspace();
    if (!isNodeTombstoned(this.#workspacePath, this.canvasId, nodeId)) {
      return false;
    }
    // An authoritative INSERT (undo/revert or explicit id reuse) may recreate
    // the sidecar, but must not clear the tombstone until topology + delta log
    // are durable. The enclosing transaction performs that reconciliation.
    if (this.tombstoneInsertBypassNodeIds?.has(nodeId)) return false;
    // Escape hatch: allow the write while the node is still listed in
    // structure, but keep the tombstone so it keeps guarding once the node
    // leaves structure again (see the note above on the delete-before-
    // autosave window). A real resurrection clears it via `write()`.
    if (this.isNodeInCurrentState(nodeId)) {
      return false;
    }
    return true;
  }

  private isNodeInCurrentState(nodeId: string): boolean {
    const canvas = this.read();
    if (!canvas) return false;
    return canvas.state.nodes.some(
      (n) => (n as { id?: unknown } | null)?.id === nodeId,
    );
  }

  // ── Artifacts ────────────────────────────────────────────────────────────
  //
  // Artifact bytes are NOT owned here. They live behind the `BlobStore`
  // port — `space(canvasId).blobs` in `storage.js` — so this store holds
  // structured records only and a non-filesystem blob backend can be
  // configured independently. See docs/proposals/multi-backend-storage.md.

  // ── Chat (removed) ───────────────────────────────────────────────────────
  //
  // Chat threads and turns are owned by the agent runtime (agenetes thread
  // and turn stores), not by this class. The read/write/list helpers that
  // used to live here had no remaining call sites and were deleted in
  // Phase 2; `chatDir()` survives because other domains own live files there.

  // ── Change-review records (ACP change card sidecar) ────────────────────────

  /**
   * Read the pending change-review records for a thread, coalesced so each
   * canvas entity is a single net record (newest state last). Coalescing
   * on read keeps every consumer — GET, revert, accept, and the next
   * append — consistent, and transparently upgrades any legacy
   * un-coalesced sidecar.
   */
  readChanges(threadId: string): CanvasChangeRecord[] {
    this.assertActiveWorkspace();
    return coalesceChanges(
      readJson<CanvasChangeRecord[]>(changesPath(this.canvasId, threadId)) ??
        [],
    );
  }

  /** Overwrite the change-review records for a thread. */
  private writeChanges(threadId: string, records: CanvasChangeRecord[]): void {
    mkdirp(chatDir(this.canvasId));
    atomicWriteJson(changesPath(this.canvasId, threadId), records);
  }

  /**
   * Merge records into a thread's pending change list, coalescing every
   * change targeting the same entity into a single net record (see
   * {@link coalesceChanges}). Returns the resulting coalesced list so the
   * caller can broadcast it verbatim.
   */
  appendChanges(
    threadId: string,
    records: CanvasChangeRecord[],
  ): CanvasChangeRecord[] {
    this.assertActiveWorkspace();
    this.requireExistingSpaceForMutation('append change records');
    const existing = this.readChanges(threadId);
    const merged = coalesceChanges([...existing, ...records]);
    this.writeChanges(threadId, merged);
    return merged;
  }

  /**
   * Remove one record by id (on accept / revert). Returns the removed
   * record, or null when the id was not present.
   */
  removeChange(threadId: string, changeId: string): CanvasChangeRecord | null {
    this.assertActiveWorkspace();
    this.requireExistingSpaceForMutation('remove a change record');
    const existing = this.readChanges(threadId);
    const idx = existing.findIndex((r) => r.id === changeId);
    if (idx < 0) return null;
    const [removed] = existing.splice(idx, 1);
    this.writeChanges(threadId, existing);
    return removed ?? null;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /**
   * Bulk append used by the batch upload endpoint. Builds a single
   * buffer of N lines and issues exactly one `write(2)` so the whole
   * batch either lands or (on crash mid-write) the trailing partial
   * line is dropped by the reader. `ts` defaults to server time when
   * the caller omits it.
   */
  appendEvents(
    events: ReadonlyArray<{ payload: RecentAction; ts?: number }>,
  ): void {
    this.assertActiveWorkspace();
    this.requireExistingSpaceForMutation('append events');
    if (events.length === 0) return;
    const now = Date.now();
    const records: CanvasEvent[] = events.map((e) => ({
      ts: e.ts ?? now,
      payload: e.payload,
    }));
    appendJsonLines<CanvasEvent>(eventsPath(this.canvasId), records);
  }

  /**
   * Read events in chronological order. When `limit` is set, only the
   * most recent `limit` records are returned (tail read).
   */
  readEvents(limit?: number): CanvasEvent[] {
    this.assertActiveWorkspace();
    return readJsonLines<CanvasEvent>(eventsPath(this.canvasId), limit);
  }

  // ── Delta log (headless executor, M2) ────────────────────────────────────
  //
  // Append-only JSONL of `Delta[]` batches produced by the server-side
  // canvas executor. One line per `POST /:canvasId/execute` call that
  // mutated state; each row carries the version it landed at, the
  // commands it applied, and the structural deltas the engine emitted.
  //
  // The wire schema (`Delta`, originator) lives in
  // `@huabu/shared/canvas-engine/delta` and `…/api/canvas` to keep
  // the contract single-sourced. Lines are line-atomic on POSIX so a
  // crash mid-write drops the trailing partial line on read.

  appendDeltaLogEntry(entry: DeltaLogEntry): void {
    this.assertActiveWorkspace();
    this.requireExistingSpaceForMutation('append a delta');
    appendJsonLine<DeltaLogEntry>(deltaLogPath(this.canvasId), entry);
  }

  /**
   * Read every delta-log row whose `version` is strictly greater than
   * `fromVersion`. Empty when no log exists yet. Returns rows in
   * write order (which equals version order — the executor mutex
   * guarantees monotonic appends).
   */
  readDeltaLogSince(fromVersion: number): DeltaLogEntry[] {
    this.assertActiveWorkspace();
    const all = readJsonLines<DeltaLogEntry>(deltaLogPath(this.canvasId));
    if (fromVersion <= 0) return all;
    return all.filter((row) => row.version > fromVersion);
  }

  /**
   * The most recently appended delta row, or null when the log is empty.
   *
   * A tail read (one line), not a full scan: the log is append-only and
   * versions increase monotonically, so the last row carries the highest
   * version. The Disk log adapter uses it to reject a duplicate or
   * out-of-order append without paying O(log size) on every write.
   */
  lastDeltaLogEntry(): DeltaLogEntry | null {
    this.assertActiveWorkspace();
    const tail = readJsonLines<DeltaLogEntry>(deltaLogPath(this.canvasId), 1);
    return tail[tail.length - 1] ?? null;
  }

  // ── Preferences (removed) ────────────────────────────────────────────────
  //
  // User and Space memory are owned by the memory sub-agent, not the
  // per-canvas store. See
  // `modules/agent/memory/`.

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Recursively delete the entire canvas directory. */
  destroy(): boolean {
    this.assertActiveWorkspace();
    if (isWorldCanvasId(this.canvasId)) {
      throw new Error('World canvas cannot be deleted');
    }
    const root = canvasRoot(this.canvasId);
    if (!existsSync(root)) {
      unregisterCanvasDir(this.canvasId);
      this.invalidateNodeIndex();
      clearSpaceNodeTombstones(this.#workspacePath, this.canvasId);
      return false;
    }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    unregisterCanvasDir(this.canvasId);
    this.invalidateNodeIndex();
    clearSpaceNodeTombstones(this.#workspacePath, this.canvasId);
    return true;
  }
}
