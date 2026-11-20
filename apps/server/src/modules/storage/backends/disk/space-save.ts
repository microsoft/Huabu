// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk result records and version stamps.
 *
 * Disk has no transaction to put a result record in, so the write that
 * carries one is bracketed by a **write-ahead intent**:
 *
 *   1. `pending.json` is written durably. It holds everything needed to
 *      finish the write's bookkeeping without the process that started it:
 *      the result record, the delta row, the advanced stamps and the Review
 *      lists the write leaves behind.
 *   2. The legacy writer runs unchanged: sidecars, `space.json`, delta row;
 *      then the Review lists, and `head.json` (the stamps) last, inside the
 *      same rollback scope.
 *   3. The result file is written, then `pending.json` is removed.
 *
 * `space.json` is replaced atomically and carries the version, so it is the
 * commit point. {@link DiskSpaceSaveState.recoverPending} reads it to decide:
 * at or past the intent's target version the write happened, and whatever
 * bookkeeping is missing — delta row, stamps, Review lists, result — is
 * completed; below it
 * the write did not happen and the intent is dropped. Recovery runs before
 * every write and every `save` call, is idempotent, and costs one `stat` when
 * the Space has never used this feature.
 *
 * What this does **not** add: sidecar writes that landed before a crash that
 * preceded `space.json` are not undone. That gap belongs to the legacy writer
 * (its before-images live in memory) and is the same with or without a result
 * record; the Space version, the delta log and the result record are
 * all-or-nothing.
 *
 * Stamps carry the version they describe. A head whose version is not the
 * record's — a crash between the two files, or a writer that bypassed
 * `SpaceHandle.write` — can no longer vouch for any node, so it is replaced by
 * a fresh lineage at the current version rather than trusted: every basis
 * issued under the old lineage is then refused, which is the safe answer.
 *
 * Everything here is synchronous on purpose; see the note in `space-write.ts`.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import {
  canvasJsonPath,
  saveDir,
  saveHeadPath,
  savePendingPath,
  saveResultExpiryDir,
  saveResultsDir,
} from './layout.js';
import { writeDiskChanges } from './space-logs.js';
import { readValidCanvasFile } from './space-record-validation.js';
import { readDiskSpaceRecord } from './space-record.js';
import { atomicWriteText } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';
import {
  advanceStamps,
  normalizeSaveKey,
  parseNodeStamps,
  SAVE_RESULT_PRUNE_LIMIT,
  SAVE_RESULT_RETENTION_MS,
  storedResultOutcome,
  validateSaveResult,
} from '../../ports/save.js';
import { assertSpaceMutationAllowed } from '../../space-lifecycle-admission.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  CanvasFile,
  DeltaLogEntry,
} from '../../../canvas/persistence-types.js';
import type {
  SaveKey,
  SaveResult,
  SpaceSave,
  SpaceStamps,
  StampAuthor,
  StoredSaveResult,
} from '../../ports/save.js';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

/** Points in a result-carrying write at which a test may stop the process. */
export type DiskSaveStage =
  | 'pending'
  | 'sidecars'
  | 'record'
  | 'delta'
  | 'reviews'
  | 'head'
  | 'result';

export interface DiskSaveOptions {
  readonly now?: () => number;
  /** Test seam: called after each named stage has reached the file system. */
  readonly onStage?: (stage: DiskSaveStage) => void;
}

interface ResultFile {
  readonly v: 1;
  readonly principalId: string;
  readonly operationId: string;
  readonly digest: string;
  readonly atVersion: number;
  readonly createdAt: number;
  readonly response: unknown;
}

interface PendingFile {
  readonly v: 1;
  readonly result: ResultFile;
  readonly expectedVersion: number;
  readonly toVersion: number;
  readonly delta: DeltaLogEntry | null;
  /** Stamps to install once the write is known to have committed. */
  readonly stamps: SpaceStamps | null;
  /**
   * The complete Review list each thread holds once the write has committed,
   * already coalesced with what was there — so installing it is a replace,
   * and doing it twice is harmless. Absent in intents written before Review
   * records were part of the write.
   */
  readonly reviews?: Readonly<Record<string, CanvasChangeRecord[]>> | null;
}

/** A result-carrying write between its intent and its completion. */
export interface DiskPendingSave {
  readonly result: ResultFile;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function readTextIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function flushDirectory(directory: string): void {
  // Directory fsync is what makes a rename survive power loss on POSIX. It is
  // unsupported on some platforms (Windows), where the rename is already as
  // durable as it will get — so a refusal here is not a failed write.
  let fd: number;
  try {
    fd = openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See above.
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace whose bytes and name are both flushed before it returns. */
function durableWriteText(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, contents, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, filePath);
    flushDirectory(directory);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function resultFilename(key: SaveKey): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([key.principalId, key.operationId]))
    .digest('hex');
  return `${digest}.json`;
}

function parseHead(raw: string, context: string): SpaceStamps {
  const parsed = JSON.parse(raw) as {
    lineage?: unknown;
    floor?: unknown;
    version?: unknown;
    nodes?: unknown;
  } | null;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.lineage !== 'string' ||
    typeof parsed.floor !== 'number' ||
    typeof parsed.version !== 'number'
  ) {
    throw new SyntaxError(`Invalid save head in ${context}`);
  }
  return {
    lineage: parsed.lineage,
    floor: parsed.floor,
    version: parsed.version,
    nodes: parseNodeStamps(parsed.nodes, context),
  };
}

function storedOf(file: ResultFile): StoredSaveResult {
  return {
    digest: file.digest,
    response: file.response,
    atVersion: file.atVersion,
  };
}

/**
 * Result records are grouped for expiry by the day they were stored.
 *
 * Their files are named by a hash of the key, so a directory listing says
 * nothing about age and "the oldest" cannot be found without reading them
 * all. Each stored result therefore leaves an empty marker of the same name
 * under `expiry/<day>/`, and expiry works by day: once a whole day is past
 * the retention window, every marker in its directory names a result that
 * may go. A prune reads a bounded number of entries from the oldest such
 * directory and removes them — every entry it reads is one it removes, so
 * it always makes progress, and it never lists the results directory.
 */
const EXPIRY_DAY_MS = 24 * 60 * 60 * 1000;

function expiryDay(time: number): number {
  return Math.floor(time / EXPIRY_DAY_MS);
}

/**
 * The reliable-save files of one Space, shared by its `write` and its `save`.
 *
 * Holds no state of its own beyond the store it was bound to: every method
 * reads the file system, so two handles for one Space — or a handle and the
 * next process — agree by construction.
 */
export class DiskSpaceSaveState {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;
  readonly #now: () => number;
  readonly #onStage: (stage: DiskSaveStage) => void;

  constructor(store: CanvasStore, options: DiskSaveOptions = {}) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
    this.#now = options.now ?? Date.now;
    this.#onStage = options.onStage ?? (() => {});
  }

  get canvasId(): string {
    return this.#store.canvasId;
  }

  assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `SpaceSave(${this.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  stage(stage: DiskSaveStage): void {
    this.#onStage(stage);
  }

  /**
   * Whether this Space has any reliable-save state at all.
   *
   * One `stat`. A Space that never asked for stamps and never stored a result
   * has no directory, and a write to it does nothing further here.
   */
  inUse(): boolean {
    return existsSync(saveDir(this.canvasId));
  }

  // ─── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Finish or drop the intent of a write that did not complete.
   *
   * Idempotent: every step checks what is already on disk, so it can be
   * interrupted and re-run, and running it with no intent present is a
   * single failed `open`.
   */
  recoverPending(): void {
    const pendingPath = savePendingPath(this.canvasId);
    const raw = readTextIfPresent(pendingPath);
    if (raw === null) return;
    // Recovery writes. A Space being deleted is fenced against that like any
    // other mutation; its intent goes with the directory.
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);

    let pending: PendingFile;
    try {
      pending = JSON.parse(raw) as PendingFile;
      if (pending?.v !== 1 || typeof pending.toVersion !== 'number') {
        throw new SyntaxError('unsupported intent');
      }
    } catch {
      // The intent is installed by rename, so it is never a torn write; an
      // unreadable one is foreign or damaged and can vouch for nothing.
      rmSync(pendingPath, { force: true });
      return;
    }

    const record = readValidCanvasFile(
      canvasJsonPath(this.canvasId),
      this.canvasId,
    );
    if (record !== null && record.version >= pending.toVersion) {
      if (pending.delta !== null) {
        const last = this.#store.lastDeltaLogEntry();
        if (last === null || last.version < pending.toVersion) {
          this.#store.appendDeltaLogEntry(pending.delta);
        }
      }
      if (pending.stamps !== null) {
        const head = this.#readHead();
        if (head === null || head.version < pending.stamps.version) {
          this.writeHead(pending.stamps);
        }
      }
      // Every Review reader finishes this intent before it looks, so nothing
      // can have changed these lists since the write computed them.
      for (const [threadId, merged] of Object.entries(pending.reviews ?? {})) {
        writeDiskChanges(this.canvasId, threadId, merged);
      }
      this.#writeResult(pending.result);
    }
    rmSync(pendingPath, { force: true });
    flushDirectory(path.dirname(pendingPath));
  }

  // ─── Result records ───────────────────────────────────────────────────────

  #resultPath(key: SaveKey): string {
    return path.join(saveResultsDir(this.canvasId), resultFilename(key));
  }

  #readResultFile(key: SaveKey): ResultFile | null {
    const raw = readTextIfPresent(this.#resultPath(key));
    if (raw === null) return null;
    const file = JSON.parse(raw) as ResultFile;
    // The filename is a hash; the body is what proves whose result this is.
    if (
      file?.v !== 1 ||
      file.principalId !== key.principalId ||
      file.operationId !== key.operationId ||
      typeof file.digest !== 'string' ||
      typeof file.atVersion !== 'number'
    ) {
      return null;
    }
    return file;
  }

  readResult(key: SaveKey): StoredSaveResult | null {
    const file = this.#readResultFile(normalizeSaveKey(key));
    return file === null ? null : storedOf(file);
  }

  #writeResult(file: ResultFile): void {
    const target = this.#resultPath(file);
    // First writer wins, and a recovery re-run must not replace the file a
    // previous run already installed.
    if (existsSync(target)) return;
    // The marker first: a crash between the two leaves a marker without a
    // result, which the prune removes, never a result nothing will expire.
    this.#markForExpiry(file);
    durableWriteText(target, JSON.stringify(file));
    this.#prune();
  }

  #markForExpiry(file: ResultFile): void {
    // The day the file is stored, not `createdAt`: an intent completed by a
    // later recovery starts its window when its result becomes readable.
    const directory = path.join(
      saveResultExpiryDir(this.canvasId),
      String(expiryDay(this.#now())),
    );
    mkdirSync(directory, { recursive: true });
    // Not flushed: losing a marker costs one result its expiry, not its use.
    writeFileSync(path.join(directory, resultFilename(file)), '');
  }

  #resultFile(
    result: SaveResult,
    response: unknown,
    atVersion: number,
  ): ResultFile {
    const key = normalizeSaveKey(result.key);
    return {
      v: 1,
      principalId: key.principalId,
      operationId: key.operationId,
      digest: result.digest,
      atVersion,
      createdAt: this.#now(),
      response,
    };
  }

  /** Store the outcome of a request that changed nothing. */
  recordResult(
    result: SaveResult,
    responseJson: string,
    atVersion: number,
  ): void {
    this.#writeResult(
      this.#resultFile(result, JSON.parse(responseJson) as unknown, atVersion),
    );
  }

  /**
   * Remove up to {@link SAVE_RESULT_PRUNE_LIMIT} expired results. Runs with
   * every write that stores one, so results cannot be created faster than
   * they expire for long: the directory holds what the retention window
   * holds, plus the day that is expiring.
   *
   * Cost per call: one listing of `expiry/` (one entry per day that has
   * results, so about as many as the window has days) and at most the limit
   * of directory entries read and files removed. Never a listing of
   * `results/`.
   *
   * A result is kept for at least {@link SAVE_RESULT_RETENTION_MS} and goes
   * when the whole day it was stored in is past that, so for at most one
   * day more.
   */
  #prune(): void {
    try {
      const root = saveResultExpiryDir(this.canvasId);
      // Days before this one ended more than the retention ago.
      const firstLiveDay = expiryDay(this.#now() - SAVE_RESULT_RETENTION_MS);
      const expired = readdirSync(root)
        .filter((name) => /^\d+$/.test(name) && Number(name) < firstLiveDay)
        .sort((a, b) => Number(a) - Number(b));
      const results = saveResultsDir(this.canvasId);
      let budget = SAVE_RESULT_PRUNE_LIMIT;
      for (const day of expired) {
        if (budget <= 0) break;
        const directory = path.join(root, day);
        const names: string[] = [];
        const handle = opendirSync(directory);
        try {
          while (names.length < budget) {
            const entry = handle.readSync();
            if (entry === null) break;
            names.push(entry.name);
          }
        } finally {
          handle.closeSync();
        }
        for (const name of names) {
          rmSync(path.join(results, name), { force: true });
          rmSync(path.join(directory, name), { force: true });
        }
        // Fewer than asked for: the day is empty now.
        if (names.length < budget) rmdirSync(directory);
        budget -= names.length;
      }
    } catch {
      // Housekeeping only: a result that outlives its retention is harmless.
    }
  }

  // ─── The write-ahead intent ───────────────────────────────────────────────

  /**
   * Record the intent of a result-carrying write before it touches anything.
   */
  begin(input: {
    result: SaveResult;
    responseJson: string;
    expectedVersion: number;
    toVersion: number;
    delta: DeltaLogEntry | undefined;
    stamps: SpaceStamps | null;
    reviews: Readonly<Record<string, CanvasChangeRecord[]>> | null;
  }): DiskPendingSave {
    const pending: PendingFile = {
      v: 1,
      result: this.#resultFile(
        input.result,
        JSON.parse(input.responseJson) as unknown,
        input.toVersion,
      ),
      expectedVersion: input.expectedVersion,
      toVersion: input.toVersion,
      delta: input.delta ?? null,
      stamps: input.stamps,
      reviews: input.reviews,
    };
    durableWriteText(savePendingPath(this.canvasId), JSON.stringify(pending));
    this.stage('pending');
    return { result: pending.result };
  }

  /** The write committed: store its result and retire the intent. */
  finish(pending: DiskPendingSave): void {
    this.#writeResult(pending.result);
    this.stage('result');
    const pendingPath = savePendingPath(this.canvasId);
    rmSync(pendingPath, { force: true });
    flushDirectory(path.dirname(pendingPath));
  }

  /**
   * The write threw. Let the record decide what that meant.
   *
   * Usually the in-process rollback restored the old version and the intent
   * is simply dropped. But a failure *after* `space.json` was replaced — and
   * a rollback that could not restore it — leaves a committed write, and then
   * the result must be kept so the caller's retry is answered rather than
   * applied a second time. If even that cannot be settled now, the intent
   * stays for the next call.
   */
  settleAfterFailure(): void {
    try {
      this.recoverPending();
    } catch {
      // The original failure is the one worth reporting.
    }
  }

  // ─── Stamps ───────────────────────────────────────────────────────────────

  #readHead(): SpaceStamps | null {
    const filePath = saveHeadPath(this.canvasId);
    const raw = readTextIfPresent(filePath);
    return raw === null ? null : parseHead(raw, filePath);
  }

  writeHead(stamps: SpaceStamps): void {
    atomicWriteText(saveHeadPath(this.canvasId), JSON.stringify(stamps));
  }

  /**
   * The stamps a write from `currentVersion` must advance, or null when the
   * Space has no baseline.
   *
   * A head that does not describe `currentVersion` is replaced, in memory, by
   * a fresh lineage; the caller persists it with whatever it writes next.
   */
  headFor(currentVersion: number): SpaceStamps | null {
    let head: SpaceStamps | null;
    try {
      head = this.#readHead();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Present but unreadable: there was a baseline and it is lost.
      return this.#freshBaseline(currentVersion);
    }
    if (head === null) return null;
    return head.version === currentVersion
      ? head
      : this.#freshBaseline(currentVersion);
  }

  #freshBaseline(version: number): SpaceStamps {
    return { lineage: randomUUID(), floor: version, version, nodes: {} };
  }

  /** Current stamps, creating the baseline when there is none. */
  ensureStamps(record: CanvasFile): SpaceStamps {
    const filePath = saveHeadPath(this.canvasId);
    let head: SpaceStamps | null = null;
    try {
      head = this.#readHead();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (head !== null && head.version === record.version) return head;
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
    const fresh = this.#freshBaseline(record.version);
    this.writeHead(fresh);
    flushDirectory(path.dirname(filePath));
    return fresh;
  }

  readRecord(): CanvasFile | null {
    return readDiskSpaceRecord(this.#store);
  }

  assertMutationAllowed(): void {
    assertSpaceMutationAllowed(this.#workspacePath, this.canvasId);
  }
}

/**
 * Stamps after one record replacement, or null when there is no baseline.
 *
 * Call only when {@link DiskSpaceSaveState.inUse} said there is something to
 * read; that one `stat` is what keeps a Space without a baseline free.
 */
export function advanceDiskStamps(
  state: DiskSpaceSaveState,
  current: CanvasFile,
  next: CanvasFile,
  author?: StampAuthor,
): SpaceStamps | null {
  const head = state.headFor(current.version);
  if (head === null) return null;
  return advanceStamps(
    head,
    current.state.nodes,
    next.state.nodes,
    next.version,
    author,
  );
}

/** Bind the `save` member of one Disk Space handle. */
export function createDiskSpaceSave(
  store: CanvasStore,
  options: DiskSaveOptions = {},
): SpaceSave {
  const state = new DiskSpaceSaveState(store, options);
  return Object.freeze({
    async lookup(key: SaveKey): Promise<StoredSaveResult | null> {
      state.assertActiveWorkspace();
      const normalized = normalizeSaveKey(key);
      if (!state.inUse()) return null;
      state.recoverPending();
      return state.readResult(normalized);
    },

    async stamps(): Promise<SpaceStamps | null> {
      state.assertActiveWorkspace();
      if (state.inUse()) state.recoverPending();
      const record = state.readRecord();
      if (record === null) return null;
      return state.ensureStamps(record);
    },

    async record(input: { expectedVersion: number; result: SaveResult }) {
      state.assertActiveWorkspace();
      if (!Number.isFinite(input.expectedVersion)) {
        throw new TypeError('expectedVersion must be a finite number');
      }
      const responseJson = validateSaveResult(input.result);
      state.assertMutationAllowed();
      if (state.inUse()) {
        state.recoverPending();
        const stored = state.readResult(input.result.key);
        if (stored) return storedResultOutcome(stored, input.result);
      }
      const record = state.readRecord();
      if (record === null) {
        throw new Error(
          `SpaceSave(${state.canvasId}) cannot record a result for a missing Space`,
        );
      }
      if (record.version !== input.expectedVersion) {
        return {
          ok: false,
          reason: 'version-conflict',
          actualVersion: record.version,
        } as const;
      }
      state.recordResult(input.result, responseJson, record.version);
      return { ok: true } as const;
    },
  });
}
