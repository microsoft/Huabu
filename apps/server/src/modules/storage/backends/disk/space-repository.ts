/**
 * Disk implementation of {@link SpaceRepository}.
 *
 * Wraps the legacy per-Space object so the record path has a portable,
 * asynchronous, version-checked contract without changing how `space.json`
 * is read or written.
 */

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SpaceRepository,
  SpaceWriteResult,
} from '../../ports/structured.js';

export class DiskSpaceRepository implements SpaceRepository {
  constructor(private readonly store: CanvasStore) {}

  async read(): Promise<CanvasFile | null> {
    return this.store.read();
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
    if (next.canvasId !== this.store.canvasId) {
      throw new Error(
        `SpaceRepository(${this.store.canvasId}) refusing to write record with id "${next.canvasId}"`,
      );
    }
    if (next.version !== expectedVersion + 1) {
      throw new Error(
        `SpaceRepository(${this.store.canvasId}) expected next.version ` +
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
    const current = this.store.read();
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
        `SpaceRepository(${this.store.canvasId}) refusing to change immutable ` +
          `record fields; title and createdAt belong to the lifecycle path`,
      );
    }
    this.store.write(next);
    return { ok: true };
  }
}
