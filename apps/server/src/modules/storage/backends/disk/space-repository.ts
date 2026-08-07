/**
 * Disk implementation of {@link SpaceRepository}.
 *
 * Wraps the legacy per-Space object so the record path has a portable,
 * asynchronous, version-checked contract without changing how `space.json`
 * is read or written.
 */

import path from 'node:path';

import {
  canvasFileShapeError,
  readValidCanvasFile,
} from './space-record-validation.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { canvasJsonPath } from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceRepository,
  SpaceWriteResult,
} from '../../ports/structured.js';

export class DiskSpaceRepository implements SpaceRepository {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `SpaceRepository(${this.#store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  async read(): Promise<CanvasFile | null> {
    this.assertActiveWorkspace();
    return readDiskSpaceRecord(this.#store);
  }

  /**
   * Version-checked replacement of the Space record.
   *
   * Validation that does not touch disk happens first, so a malformed `next`
   * is rejected before the critical section runs.
   */
  async compareAndSwap(
    expectedVersion: number,
    next: CanvasFile,
  ): Promise<SpaceWriteResult> {
    this.assertActiveWorkspace();
    if (!Number.isFinite(expectedVersion)) {
      throw new TypeError(
        `SpaceRepository(${this.#store.canvasId}) expectedVersion must be a finite number`,
      );
    }
    const shapeError = canvasFileShapeError(next, this.#store.canvasId);
    if (shapeError) {
      throw new TypeError(
        `SpaceRepository(${this.#store.canvasId}) received an invalid next record: ${shapeError}`,
      );
    }
    if (next.version !== expectedVersion + 1) {
      throw new Error(
        `SpaceRepository(${this.#store.canvasId}) expected next.version ` +
          `${expectedVersion + 1}, received ${next.version}`,
      );
    }
    return this.swapIfCurrent(expectedVersion, next);
  }

  /**
   * The critical section: read the current version, compare, and write.
   *
   * ⚠️ This method MUST NOT `await`. Its single-winner guarantee rests
   * entirely on running to completion in one uninterrupted JavaScript turn —
   * `read()` and `write()` on the legacy object are synchronous, so no other
   * repository call can observe or overwrite the record between the check and
   * the write. Someone swapping a sync call for `fs/promises` breaks that
   * silently: both writers would capture the same version before yielding,
   * both would find it unchanged on resume, and both would "succeed" while
   * only one write survived.
   *
   * The contract suite catches exactly that by issuing its two writers from
   * one tick against a shared baseline, with no await between them. That
   * ordering is what discriminates: separating them with a yield makes the
   * second writer read the already-updated record, which is a sequential
   * stale-baseline test and passes even for a broken adapter. The suite
   * covers that case too, but as its own assertion rather than as the race.
   *
   * This holds for the supported single-Server Disk topology. An adapter that
   * cannot honor it structurally — SQLite, Postgres — must use a transaction
   * or a conditional update across all of its connections, or take an
   * explicit lock. A comment is not a mechanism.
   */
  private swapIfCurrent(
    expectedVersion: number,
    next: CanvasFile,
  ): SpaceWriteResult {
    const current = readDiskSpaceRecord(this.#store);
    if (!current) return { ok: false, reason: 'not-found' };
    if (current.version !== expectedVersion) {
      return {
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version,
      };
    }
    // Identity and title are not this repository's to change: rename and
    // lifecycle stay on the compatibility path this phase (§12.2.5).
    if (next.title !== current.title || next.createdAt !== current.createdAt) {
      throw new Error(
        `SpaceRepository(${this.#store.canvasId}) refusing to change immutable ` +
          `record fields; title and createdAt belong to the lifecycle path`,
      );
    }
    this.#store.write(next);
    return { ok: true };
  }
}

/**
 * Read and validate one record, refreshing the directory index once when the
 * indexed path is absent so externally renamed Spaces remain discoverable.
 * The already-parsed value is then reconciled by the compatibility store;
 * there is no second, lenient disk read that could hide corruption.
 */
export function readDiskSpaceRecord(store: CanvasStore): CanvasFile | null {
  let record = readValidCanvasFile(
    canvasJsonPath(store.canvasId),
    store.canvasId,
  );
  if (!record) {
    // Preserve Finder-rename recovery, but validate the newly indexed path
    // before the compatibility reader gets a chance to self-heal its title.
    refreshCanvasDirIndex();
    record = readValidCanvasFile(
      canvasJsonPath(store.canvasId),
      store.canvasId,
    );
  }
  if (!record) return null;
  return store.reconcileValidatedRecord(record);
}
