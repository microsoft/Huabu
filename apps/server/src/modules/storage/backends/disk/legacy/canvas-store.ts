// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-canvas storage facade. One instance per `<canvasDir>/`.
 */

import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
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
import { assertSpaceMutationAllowed } from './space-lifecycle-admission.js';
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
import {
  patchCanvasDirTitle,
  refreshCanvasDirIndex,
  registerCanvasDir,
  renameCanvasDirOnDisk,
  isWorldCanvasId,
  unregisterCanvasDir,
} from '../../../../workspace/disk/canvas-dirs.js';
import { NameIndex } from '../../../../workspace/disk/name-index.js';
import { toSafeFilename } from '../../../../workspace/disk/naming.js';
import {
  canvasJsonPath,
  canvasRoot,
  changesPath,
  chatDir,
  deltaLogPath,
  eventsPath,
  intentPath,
  nodeFilePath,
  nodesDir,
} from '../../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../../workspace.js';
import { readValidCanvasFile } from '../space-record-validation.js';

import type {
  CanvasEvent,
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../../canvas/persistence-types.js';
import type { IntentEpisode, RecentAction } from '@huabu/shared';
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

/** @internal Tombstone metadata settlement owned by the aggregate journal. */
export interface NodeMutationTombstoneSettlement {
  /** Apply resurrection reconciliation after the journal commit marker lands. */
  commit(): void;
  /** Restore exact pre-transaction metadata when the journal is aborted. */
  rollback(): void;
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
  | { ok: false; reason: 'plan-drift' }
  | { ok: false; reason: 'not-found' };

export type PlannedNodeMutation =
  | {
      readonly kind: 'put';
      readonly nodeId: string;
      readonly sourceFilename: string | null;
      readonly targetFilename: string;
      /** Exact canonical record serialized at the planned target. */
      readonly record: NodeContent;
    }
  | {
      readonly kind: 'delete';
      readonly nodeId: string;
      readonly sourceFilename: string | null;
    };

export interface NodeMutationJournalPlan {
  readonly filenames: readonly string[];
  readonly mutations: readonly PlannedNodeMutation[];
}

export type NodeMutationJournalPlanResult =
  | { readonly ok: true; readonly plan: NodeMutationJournalPlan }
  | {
      readonly ok: false;
      readonly reason: 'conflict';
      readonly nodeId: string;
      readonly conflictWith: { readonly id: string; readonly filename: string };
    }
  | {
      readonly ok: false;
      readonly reason: 'duplicate';
      readonly nodeId: string;
      readonly files: readonly string[];
    };

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

export class CanvasStore {
  readonly canvasId: string;
  /** Workspace this handle was created for; handles never follow activation. */
  readonly #workspacePath: string;
  private nodes: NameIndex<NodeFileEntry> | null = null;
  /**
   * Ids that resolve to more than one `.md` sidecar on disk, captured
   * during the most recent index scan. Kept in sync with {@link nodes}:
   * every rebuild reassigns both. Consumed by the access-time duplicate
   * guard so reads/writes of an affected node can surface the conflict
   * instead of silently picking one file.
   */
  private nodeDuplicateIds = new Set<string>();
  /**
   * Synchronous aggregate commit batches validate the record once before
   * touching several sidecars. Only node guards consult this depth; the
   * callback never escapes and standalone mutations still perform their own
   * strict read.
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
   * title for this read. The common case where
   * `dirName === safe(title)` (e.g. title contains `?` / `:` / `/` that
   * was sanitised at create time) is left alone — overwriting there
   * would silently strip the user's typed characters from the title.
   */
  read(): CanvasFile | null {
    const file = this.readPersisted();
    return file === null ? null : this.reconcileValidatedRecord(file);
  }

  /** @internal Read the durable record without applying Finder title display semantics. */
  readPersisted(): CanvasFile | null {
    this.assertActiveWorkspace();
    let file = readValidCanvasFile(
      canvasJsonPath(this.canvasId),
      this.canvasId,
    );
    if (!file) {
      refreshCanvasDirIndex();
      file = readValidCanvasFile(canvasJsonPath(this.canvasId), this.canvasId);
      if (!file) return null;
    }
    return file;
  }

  /**
   * @internal Project Finder-title semantics without rereading or writing.
   *
   * Reads must stay observational now that every durable title change belongs
   * to `SpaceCommit`. A directory renamed outside the app is therefore a
   * display override until the next real save persists the projected title.
   */
  reconcileValidatedRecord(file: CanvasFile): CanvasFile {
    this.assertActiveWorkspace();
    if (file.canvasId !== this.canvasId) {
      throw new Error(
        `CanvasStore(${this.canvasId}) cannot reconcile record "${file.canvasId}"`,
      );
    }
    const dirName = path.basename(canvasRoot(this.canvasId));
    const expectedDir = toSafeFilename(file.title, this.canvasId);
    if (!isWorldCanvasId(this.canvasId) && dirName && dirName !== expectedDir) {
      return { ...file, title: dirName };
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
   * Run one synchronous aggregate sidecar batch behind a single strict
   * `space.json` validation.
   *
   * @internal This is deliberately absent from the storage ports and runtime
   * facade. `DiskSpaceCommitter` owns the Space mutex and performs all of its
   * sidecar mutations without yielding, so the validated record cannot change
   * between this check and the guarded writes/deletes in the callback.
   */
  withValidatedNodeMutationTransaction<T>(
    options: {
      affectedNodeIds: ReadonlySet<string>;
      insertedNodeIds: ReadonlySet<string>;
      /**
       * Defer tombstone settlement to the aggregate journal decision. The
       * callback's file/record/log writes are not durable as one decision
       * until `COMMITTED`, so resurrection metadata cannot be cleared sooner.
       */
      deferTombstoneSettlement?: (
        settlement: NodeMutationTombstoneSettlement,
      ) => void;
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
      const reconcileNodeIds = new Set(
        this.deferredTombstoneReconciliationNodeIds,
      );
      let settled = false;
      const settlement: NodeMutationTombstoneSettlement = {
        commit: () => {
          if (settled) return;
          for (const id of reconcileNodeIds) {
            clearNodeTombstone(this.#workspacePath, this.canvasId, id);
          }
          settled = true;
        },
        rollback: () => {
          if (settled) return;
          restoreNodeTombstones(
            this.#workspacePath,
            this.canvasId,
            tombstoneSnapshot,
          );
          settled = true;
        },
      };
      if (options.deferTombstoneSettlement) {
        options.deferTombstoneSettlement(settlement);
      } else {
        // Compatibility callers without an enclosing Disk journal retain the
        // original callback-success boundary.
        settlement.commit();
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

  private nodeIndex(): NameIndex<NodeFileEntry> {
    if (this.nodes) return this.nodes;
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const raw = readText(path.join(dir, file));
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
    this.nodeDuplicateIds = duplicates;
    return idx;
  }

  private invalidateNodeIndex(): void {
    this.nodes = null;
  }

  /**
   * @internal Enumerate every existing/target sidecar a legacy mutation batch
   * may touch. Disk SpaceCommit publishes these paths in its undo journal
   * before invoking the writer, including targets that do not exist yet.
   */
  planNodeMutationsForJournal(
    mutations: readonly (
      | { kind: 'put'; record: NodeContent; strictRename?: boolean }
      | { kind: 'delete'; nodeId: string }
    )[],
  ): NodeMutationJournalPlanResult {
    this.assertActiveWorkspace();
    // The plan is an undo-journal declaration, not a filename hint. Always
    // rescan after watcher handles have been released so a Finder-created
    // sibling cannot make the legacy writer choose an undeclared dedupe
    // target later in the transaction.
    this.invalidateNodeIndex();
    const current = this.nodeIndex();

    const simulated = new NameIndex<NodeFileEntry>(current.list());
    const filenames = new Set<string>();
    const planned: PlannedNodeMutation[] = [];
    for (const mutation of mutations) {
      const nodeId =
        mutation.kind === 'put' ? mutation.record.nodeId : mutation.nodeId;
      const existing = simulated.get(nodeId);
      if (existing) filenames.add(existing.filename);

      if (this.nodeDuplicateIds.has(nodeId)) {
        return {
          ok: false,
          reason: 'duplicate',
          nodeId,
          files: this.duplicateNodeFilenames(nodeId),
        };
      }

      if (mutation.kind === 'delete') {
        planned.push({
          kind: 'delete',
          nodeId,
          sourceFilename: existing?.filename ?? null,
        });
        simulated.remove(nodeId);
        continue;
      }

      const trimmedLabel =
        typeof mutation.record.label === 'string' &&
        mutation.record.label.trim().length > 0
          ? mutation.record.label
          : null;
      const desired =
        trimmedLabel === null && existing
          ? existing.filename
          : nodeFilenameFor(nodeId, trimmedLabel);
      let target = existing?.filename ?? desired;
      if (!existing || existing.filename !== desired) {
        const conflict = simulated.findByName(desired);
        if (!conflict || conflict.id === nodeId) {
          target = desired;
        } else if (mutation.strictRename) {
          return {
            ok: false,
            reason: 'conflict',
            nodeId,
            conflictWith: {
              id: conflict.id,
              filename: conflict.filename,
            },
          };
        } else {
          target = simulated.suggestUnique(desired, true, nodeId);
        }
      }
      const desiredStem = desired.replace(/\.md$/, '');
      const targetStem = target.replace(/\.md$/, '');
      const suffix =
        targetStem.length > desiredStem.length &&
        targetStem.startsWith(desiredStem)
          ? targetStem.slice(desiredStem.length)
          : '';
      const finalLabel =
        suffix && trimmedLabel ? `${trimmedLabel}${suffix}` : trimmedLabel;
      const finalRecord: NodeContent =
        suffix && trimmedLabel
          ? { ...mutation.record, label: finalLabel }
          : mutation.record;
      filenames.add(target);
      planned.push({
        kind: 'put',
        nodeId,
        sourceFilename: existing?.filename ?? null,
        targetFilename: target,
        record: finalRecord,
      });
      if (existing) {
        simulated.rename(nodeId, target);
      } else {
        simulated.add({ id: nodeId, filename: target });
      }
    }
    return {
      ok: true,
      plan: { filenames: [...filenames], mutations: planned },
    };
  }

  /** @internal Exact sidecar after-states for a deterministic Disk journal. */
  materializeNodeMutationPlan(
    plan: NodeMutationJournalPlan,
  ): readonly { readonly filename: string; readonly after: Buffer | null }[] {
    const afterByFilename = new Map<string, Buffer | null>();
    for (const mutation of plan.mutations) {
      if (mutation.kind === 'delete') {
        if (mutation.sourceFilename !== null) {
          afterByFilename.set(mutation.sourceFilename, null);
        }
        continue;
      }
      if (
        mutation.sourceFilename !== null &&
        mutation.sourceFilename !== mutation.targetFilename
      ) {
        afterByFilename.set(mutation.sourceFilename, null);
      }
      afterByFilename.set(
        mutation.targetFilename,
        Buffer.from(nodeContentToMarkdown(mutation.record), 'utf8'),
      );
    }
    return plan.filenames.map((filename) => {
      const after = afterByFilename.get(filename);
      if (after === undefined) {
        throw new Error(
          `Missing planned after-state for node file ${filename}`,
        );
      }
      return { filename, after };
    });
  }

  /**
   * @internal Stage only process/durable anti-resurrection metadata after the
   * deterministic file transaction has applied. File bytes are journal-owned.
   */
  stageNodeMutationTombstones(
    mutations: readonly PlannedNodeMutation[],
    resurrectedNodeIds: ReadonlySet<string>,
  ): void {
    if (
      this.nodeMutationTransactionDepth === 0 ||
      this.deferredTombstoneReconciliationNodeIds === null
    ) {
      throw new Error(
        'Node tombstone staging requires an aggregate transaction',
      );
    }
    for (const mutation of mutations) {
      if (mutation.kind === 'delete') {
        markNodeDeleted(this.#workspacePath, this.canvasId, mutation.nodeId);
      }
    }
    for (const nodeId of resurrectedNodeIds) {
      if (isNodeTombstoned(this.#workspacePath, this.canvasId, nodeId)) {
        this.deferredTombstoneReconciliationNodeIds.add(nodeId);
      }
    }
  }

  /** @internal Drop path caches after raw journal recovery restored bytes. */
  invalidateNodeIndexAfterTransactionRecovery(): void {
    this.assertActiveWorkspace();
    refreshCanvasDirIndex();
    this.invalidateNodeIndex();
  }

  /**
   * Reconcile the cached node index against disk for a single-node read
   * (the manual-refresh path), dropping the cache only when a rescan is
   * actually warranted. Two triggers force the drop:
   *
   *   1. `nodeId` is currently flagged duplicate. The cheap count probe
   *      below can't see a duplicate being *resolved*: while duplicated,
   *      the index collapses the two sidecars to one id, so deleting one
   *      file makes the on-disk `.md` count match the cached index size
   *      again (1 === 1) and the probe reads "fresh". A flagged node
   *      therefore always re-reads so the resolution is detected.
   *   2. the on-disk `.md` count drifted from the index size — a sibling
   *      sidecar appeared or vanished since the last scan (e.g. a new
   *      duplicate, or another CanvasStore instance's write).
   *
   * Otherwise the warm cache is trusted. The probe is a names-only
   * `readdir`; per-file contents are only re-read when a rescan fires.
   */
  revalidateNodeForRead(nodeId: string): void {
    this.assertActiveWorkspace();
    const idx = this.nodeIndex();
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
   * Cheap staleness probe: compare the number of `.md` files currently on
   * disk against the cached index size. A names-only `readdirSync` (no
   * file contents read) is enough to notice that a sidecar appeared or
   * vanished since the last scan — the signal {@link writeNode} uses to
   * decide whether a full content rescan is needed before treating a
   * write as a create. Returns `true` when a rescan is warranted.
   */
  private nodeIndexCountStale(idx: NameIndex<NodeFileEntry>): boolean {
    const dir = nodesDir(this.canvasId);
    if (!existsSync(dir)) return idx.size() > 0;
    let count = 0;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md')) count++;
    }
    return count !== idx.size();
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

  /**
   * Backend-private logical name lookup for the structured node adapter.
   *
   * The return value is always a single directory entry name, never a path.
   * Keeping this lookup beside the id index preserves externally renamed and
   * deduplicated names without leaking Disk paths into the portable port.
   */
  nodeLogicalName(nodeId: string): string {
    this.assertActiveWorkspace();
    return this.nodeFilenameOf(nodeId);
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

  /** Async counterpart used by the portable structured node repository. */
  async readNodeAsync(nodeId: string): Promise<NodeContent | null> {
    this.assertActiveWorkspace();
    const filename = this.nodeFilenameOf(nodeId);
    let raw = await readTextAsync(nodeFilePath(this.canvasId, filename));
    if (raw === null) {
      this.invalidateNodeIndex();
      const retryFilename = this.nodeFilenameOf(nodeId);
      if (retryFilename !== filename) {
        raw = await readTextAsync(nodeFilePath(this.canvasId, retryFilename));
      }
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
   * Reads run concurrently (bounded by {@link NODE_READ_CONCURRENCY})
   * via async, non-blocking `readFile` calls so the event loop stays
   * free and large canvases hydrate with overlapped I/O. The id index
   * is still built in stable `readdirSync` order so the derived keys
   * match the previous synchronous implementation exactly.
   */
  async readAllNodes(options?: {
    strict?: boolean;
  }): Promise<Map<string, NodeContent>> {
    this.assertActiveWorkspace();
    const contents = new Map<string, NodeContent>();
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
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
        if (raw === null) continue;
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
        contents.set(id, markdownToNodeContent(id, raw, options?.strict));
      }
    }
    this.nodes = idx;
    this.nodeDuplicateIds = duplicates;
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
   */
  async streamAllNodes(
    onNode: (id: string, content: NodeContent) => void,
    signal?: { readonly aborted: boolean },
  ): Promise<Map<string, NodeContent>> {
    this.assertActiveWorkspace();
    const contents = new Map<string, NodeContent>();
    const idx = new NameIndex<NodeFileEntry>();
    const duplicates = new Set<string>();
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((file) => file.endsWith('.md'));
      await mapWithConcurrency(files, NODE_READ_CONCURRENCY, async (file) => {
        if (signal?.aborted) return;
        const raw = await readTextAsync(path.join(dir, file));
        if (raw === null) return;
        // Same id derivation as `readAllNodes()` / `nodeIndex()`.
        const { meta } = parseFrontmatter(raw);
        const rawId = meta['id'];
        const id =
          typeof rawId === 'string' && rawId
            ? rawId
            : file.replace(/\.md$/, '');
        addSidecarToIndex(idx, duplicates, this.canvasId, id, file);
        const content = markdownToNodeContent(id, raw);
        contents.set(id, content);
        // JS is single-threaded between awaits, so even though
        // multiple workers may be in-flight, exactly one onNode call
        // runs at a time. Callers can mutate shared counters safely.
        onNode(id, content);
      });
    }
    this.nodes = idx;
    this.nodeDuplicateIds = duplicates;
    return contents;
  }

  /**
   * Write a node's markdown. Strict mode refuses sibling-label
   * collisions; lazy mode auto-dedupes with `(2)` / `(3)` suffixes.
   */
  writeNode(
    nodeId: string,
    content: NodeContent,
    opts: {
      strictRename?: boolean;
      plannedMutation?: Extract<PlannedNodeMutation, { kind: 'put' }>;
    } = {},
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
    //   2. the on-disk `.md` count no longer matches the index size
    //      (a sibling appeared / vanished — e.g. another instance's write).
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

    // Aggregate commits declare every source/target in their undo journal.
    // Refuse a late filesystem/index drift before creating a directory or
    // writing bytes; silently selecting a fresh `(N)` target here would leave
    // an unjournaled ghost after rollback.
    if (
      opts.plannedMutation &&
      (opts.plannedMutation.nodeId !== nodeId ||
        opts.plannedMutation.sourceFilename !== (existing?.filename ?? null) ||
        opts.plannedMutation.targetFilename !== target)
    ) {
      return { ok: false, reason: 'plan-drift' };
    }

    mkdirp(nodesDir(this.canvasId));

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
        if (!rollback.ok) this.nodeDuplicateIds.add(nodeId);
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
   * Called from the aggregate Space commit authority. The
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
  // port — `canvasBlobs(canvasId)` in `storage.js` — so this store holds
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

  // ── Intent ───────────────────────────────────────────────────────────────

  readIntents(): IntentEpisode[] {
    this.assertActiveWorkspace();
    return readJson<IntentEpisode[]>(intentPath(this.canvasId)) ?? [];
  }

  upsertIntent(episode: IntentEpisode): void {
    this.assertActiveWorkspace();
    this.requireExistingSpaceForMutation('upsert an intent');
    const list = this.readIntents();
    const idx = list.findIndex((e) => e.id === episode.id);
    if (idx >= 0) {
      list[idx] = episode;
    } else {
      list.push(episode);
    }
    mkdirp(path.dirname(intentPath(this.canvasId)));
    atomicWriteJson(intentPath(this.canvasId), list);
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
