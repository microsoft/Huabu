/**
 * Disk implementation of {@link CanvasLogRepository}.
 *
 * Wraps the legacy per-Space object so the four Canvas log families have a
 * portable asynchronous contract. Where the port promises a synchronization
 * property the legacy path did not state — delta ordering in particular — the
 * guarantee is enforced here rather than inherited by accident.
 */

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasEvent, DeltaLogEntry } from '../../../canvas/persistence-types.js';
import type {
  CanvasLogRepository,
  NewCanvasEvent,
} from '../../ports/structured.js';
import type { IntentEpisode } from '@sediment/shared';
import type { CanvasChangeRecord } from '@sediment/shared/canvas-engine';

export class DiskCanvasLogRepository implements CanvasLogRepository {
  constructor(private readonly store: CanvasStore) {}

  // ── Events ────────────────────────────────────────────────────────────────

  async appendEvents(events: readonly NewCanvasEvent[]): Promise<void> {
    // One buffer, one write(2): the batch lands contiguously or (on a crash
    // mid-write) its trailing partial line is dropped by the reader.
    this.store.appendEvents(events);
  }

  async readEvents(limit?: number): Promise<CanvasEvent[]> {
    return this.store.readEvents(limit);
  }

  // ── Delta log ─────────────────────────────────────────────────────────────

  async appendDelta(entry: DeltaLogEntry): Promise<void> {
    this.appendDeltaIfNewer(entry);
  }

  async readDeltasSince(fromVersion: number): Promise<DeltaLogEntry[]> {
    return this.store.readDeltaLogSince(fromVersion);
  }

  /**
   * Guard and append in one turn.
   *
   * ⚠️ MUST NOT `await`. The uniqueness guarantee — no two rows share a
   * version, and versions strictly increase — holds only because the tail
   * read and the append run in one uninterrupted JavaScript turn, so a
   * concurrent append cannot slip between them. See the same constraint on
   * `DiskSpaceRepository.swapIfCurrent`, which documents what the contract
   * suite's ordering has to be to detect a violation and what a
   * connection-based adapter must do instead.
   */
  private appendDeltaIfNewer(entry: DeltaLogEntry): void {
    const last = this.store.lastDeltaLogEntry();
    if (last && entry.version <= last.version) {
      throw new Error(
        `CanvasLogRepository(${this.store.canvasId}) refusing delta version ` +
          `${entry.version}; the log is already at ${last.version}`,
      );
    }
    this.store.appendDeltaLogEntry(entry);
  }

  // ── Change-review records ─────────────────────────────────────────────────

  async readChanges(threadId: string): Promise<CanvasChangeRecord[]> {
    return this.store.readChanges(threadId);
  }

  async appendChanges(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]> {
    // Legacy `appendChanges` is itself read → coalesce → write with no
    // `await`, so it is already the whole critical section: two concurrent
    // appends to the same thread cannot interleave and lose a record.
    return this.store.appendChanges(threadId, [...records]);
  }

  async removeChange(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    return this.store.removeChange(threadId, changeId);
  }

  // ── Intent episodes ───────────────────────────────────────────────────────

  async readIntents(): Promise<IntentEpisode[]> {
    return this.store.readIntents();
  }

  async upsertIntent(episode: IntentEpisode): Promise<void> {
    // Same argument as `appendChanges`: read → merge → write, `await`-free.
    this.store.upsertIntent(episode);
  }
}
