/**
 * Disk implementations of the four Canvas log-family repositories.
 *
 * The implementation stays co-located because all four families share the
 * same legacy per-Space object and workspace-lifetime guard. Callers receive
 * four frozen, runtime-narrow facades rather than this coordinator, so no
 * family can reach unrelated methods or the legacy object.
 *
 * Where a port promises a synchronization property the legacy path did not
 * state — delta ordering in particular — the guarantee is enforced here
 * rather than inherited by accident.
 */

import path from 'node:path';

import { z } from 'zod';

import {
  canvasEventInputSchema,
  canvasEventRecordSchema,
  executeOriginatorSchema,
  type IntentEpisode,
} from '@sediment/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@sediment/shared/canvas-engine';

import { assertSpaceMutationAllowed } from './legacy/space-lifecycle-admission.js';
import { readDiskSpaceRecord } from './space-repository.js';
import {
  atomicWriteJson,
  readJsonLinesStrict,
  readJsonStrict,
  repairJsonLinesTail,
} from '../../../../utils/fs.js';
import {
  changesPath,
  deltaLogPath,
  eventsPath,
  intentPath,
} from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  CanvasEvent,
  DeltaLogEntry,
} from '../../../canvas/persistence-types.js';
import type {
  CanvasChangeRepository,
  CanvasDeltaRepository,
  CanvasEventRepository,
  CanvasIntentRepository,
  NewCanvasEvent,
} from '../../ports/structured.js';

const deltaLogEntrySchema = z
  .object({
    version: z.number().finite(),
    ts: z.number().finite(),
    runId: z.string().optional(),
    commands: z.array(z.unknown()),
    deltas: z.array(z.unknown()),
    originator: executeOriginatorSchema,
  })
  .passthrough();

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown schema violation';
  const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${location}: ${issue.message}`;
}

function validateEventInput(value: unknown, index: number): void {
  const parsed = canvasEventInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(
      `Invalid Canvas event append input at index ${index}: ${firstIssue(parsed.error)}`,
    );
  }
}

function validateDeltaInput(value: unknown): void {
  const parsed = deltaLogEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(
      `Invalid Canvas delta append input: ${firstIssue(parsed.error)}`,
    );
  }
}

function readValidatedEvents(filePath: string, limit?: number): CanvasEvent[] {
  const records = readJsonLinesStrict<unknown>(filePath).map(
    (value, index): CanvasEvent => {
      const parsed = canvasEventRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new SyntaxError(
          `Invalid Canvas event record ${index + 1} in ${filePath}: ${firstIssue(parsed.error)}`,
        );
      }
      // Validate without returning Zod's normalized object: persistence reads
      // must preserve the exact valid JSON value supplied by the backend.
      return value as CanvasEvent;
    },
  );

  if (limit === undefined) return records;
  if (!(limit > 0)) return [];
  return records.slice(-Math.ceil(limit));
}

function validateDeltaRecord(
  value: unknown,
  filePath: string,
  index: number,
): DeltaLogEntry {
  const parsed = deltaLogEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new SyntaxError(
      `Invalid Canvas delta record ${index + 1} in ${filePath}: ${firstIssue(parsed.error)}`,
    );
  }
  return value as DeltaLogEntry;
}

function readValidatedDeltas(filePath: string): DeltaLogEntry[] {
  return readJsonLinesStrict<unknown>(filePath).map((value, index) =>
    validateDeltaRecord(value, filePath, index),
  );
}

function readJsonArray<T>(filePath: string, family: string): T[] {
  const parsed = readJsonStrict<unknown>(filePath);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) {
    throw new SyntaxError(
      `Expected ${family} to be a JSON array in ${filePath}`,
    );
  }
  return parsed as T[];
}

export interface DiskCanvasLogRepositories {
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
}

class DiskCanvasLogCoordinator {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `Canvas log repositories(${this.#store.canvasId}) belong to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  private requireSpace(): void {
    assertSpaceMutationAllowed(this.#workspacePath, this.#store.canvasId);
    if (!readDiskSpaceRecord(this.#store)) {
      throw new Error(
        `Canvas log repositories(${this.#store.canvasId}) cannot write logs for a missing Space`,
      );
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async appendEvents(events: readonly NewCanvasEvent[]): Promise<void> {
    this.assertActiveWorkspace();
    if (events.length === 0) return;
    events.forEach(validateEventInput);
    this.requireSpace();
    // One buffer, one write(2): the batch lands contiguously or (on a crash
    // mid-write) its trailing partial line is repaired before the next append.
    this.#store.appendEvents(events);
  }

  async readEvents(limit?: number): Promise<CanvasEvent[]> {
    this.assertActiveWorkspace();
    return readValidatedEvents(eventsPath(this.#store.canvasId), limit);
  }

  // ── Delta log ─────────────────────────────────────────────────────────────

  async appendDelta(entry: DeltaLogEntry): Promise<void> {
    this.assertActiveWorkspace();
    validateDeltaInput(entry);
    this.appendDeltaIfNewer(entry);
  }

  async readDeltasSince(fromVersion: number): Promise<DeltaLogEntry[]> {
    this.assertActiveWorkspace();
    const all = readValidatedDeltas(deltaLogPath(this.#store.canvasId));
    if (fromVersion <= 0) return all;
    return all.filter((row) => row.version > fromVersion);
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
    this.requireSpace();
    const filePath = deltaLogPath(this.#store.canvasId);
    // Repair first so the validated scan observes the last complete row.
    // A valid unterminated row is kept; a malformed crash fragment is removed.
    repairJsonLinesTail(filePath);
    const rows = readValidatedDeltas(filePath);
    const last = rows[rows.length - 1] ?? null;
    if (last && entry.version <= last.version) {
      throw new Error(
        `CanvasDeltaRepository(${this.#store.canvasId}) refusing delta version ` +
          `${entry.version}; the log is already at ${last.version}`,
      );
    }
    this.#store.appendDeltaLogEntry(entry);
  }

  // ── Change-review records ─────────────────────────────────────────────────

  async readChanges(threadId: string): Promise<CanvasChangeRecord[]> {
    this.assertActiveWorkspace();
    return coalesceChanges(
      readJsonArray<CanvasChangeRecord>(
        changesPath(this.#store.canvasId, threadId),
        'change-review records',
      ),
    );
  }

  async appendChanges(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]> {
    this.assertActiveWorkspace();
    this.requireSpace();
    const filePath = changesPath(this.#store.canvasId, threadId);
    const existing = coalesceChanges(
      readJsonArray<CanvasChangeRecord>(filePath, 'change-review records'),
    );
    const merged = coalesceChanges([...existing, ...records]);
    atomicWriteJson(filePath, merged);
    return merged;
  }

  async removeChange(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    this.assertActiveWorkspace();
    this.requireSpace();
    const filePath = changesPath(this.#store.canvasId, threadId);
    const existing = coalesceChanges(
      readJsonArray<CanvasChangeRecord>(filePath, 'change-review records'),
    );
    const idx = existing.findIndex((record) => record.id === changeId);
    if (idx < 0) return null;
    const [removed] = existing.splice(idx, 1);
    atomicWriteJson(filePath, existing);
    return removed ?? null;
  }

  // ── Intent episodes ───────────────────────────────────────────────────────

  async readIntents(): Promise<IntentEpisode[]> {
    this.assertActiveWorkspace();
    return readJsonArray<IntentEpisode>(
      intentPath(this.#store.canvasId),
      'intent episodes',
    );
  }

  async upsertIntent(episode: IntentEpisode): Promise<void> {
    this.assertActiveWorkspace();
    this.requireSpace();
    const filePath = intentPath(this.#store.canvasId);
    const episodes = readJsonArray<IntentEpisode>(filePath, 'intent episodes');
    const idx = episodes.findIndex((candidate) => candidate.id === episode.id);
    if (idx >= 0) episodes[idx] = episode;
    else episodes.push(episode);
    atomicWriteJson(filePath, episodes);
  }
}

/**
 * Build the four log-family repositories for one Space.
 *
 * Each facade is frozen and contains only its own operations. The shared
 * coordinator — and therefore its legacy store — is closure-private.
 */
export function createDiskCanvasLogRepositories(
  store: CanvasStore,
): DiskCanvasLogRepositories {
  const coordinator = new DiskCanvasLogCoordinator(store);

  const events: CanvasEventRepository = Object.freeze({
    append: (entries: readonly NewCanvasEvent[]) =>
      coordinator.appendEvents(entries),
    read: (limit?: number) => coordinator.readEvents(limit),
  });
  const deltas: CanvasDeltaRepository = Object.freeze({
    append: (entry: DeltaLogEntry) => coordinator.appendDelta(entry),
    readSince: (fromVersion: number) =>
      coordinator.readDeltasSince(fromVersion),
  });
  const changes: CanvasChangeRepository = Object.freeze({
    read: (threadId: string) => coordinator.readChanges(threadId),
    append: (threadId: string, records: readonly CanvasChangeRecord[]) =>
      coordinator.appendChanges(threadId, records),
    remove: (threadId: string, changeId: string) =>
      coordinator.removeChange(threadId, changeId),
  });
  const intents: CanvasIntentRepository = Object.freeze({
    read: () => coordinator.readIntents(),
    upsert: (episode: IntentEpisode) => coordinator.upsertIntent(episode),
  });

  return Object.freeze({ events, deltas, changes, intents });
}
