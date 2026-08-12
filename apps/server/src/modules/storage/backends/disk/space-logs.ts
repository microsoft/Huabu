// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementations of the append-structured Space parts: events, intents,
 * change-review records, and the executor journal.
 *
 * The implementation stays co-located because all four share the same legacy
 * per-Space object and workspace-lifetime guard. Callers receive frozen,
 * runtime-narrow facades rather than this coordinator, so no part can reach
 * unrelated methods or the legacy object.
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
} from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { readDiskSpaceRecord } from './space-record.js';
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
import { assertSpaceMutationAllowed } from '../../space-lifecycle-admission.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  CanvasEvent,
  DeltaLogEntry,
} from '../../../canvas/persistence-types.js';
import type {
  NewCanvasEvent,
  SpaceChanges,
  SpaceEvents,
  SpaceIntents,
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

export interface DiskSpaceLogs {
  readonly events: SpaceEvents;
  readonly changes: SpaceChanges;
  readonly intents: SpaceIntents;
}

/**
 * Disk's executor journal (`delta-log.jsonl`).
 *
 * Not a member of `SpaceHandle`: nothing a reader of a Space needs to
 * understand is expressed by the journal, and the write that produces a row
 * takes it as an argument. This stays because the file is durable state whose
 * validation and crash-fragment tolerance are worth testing directly.
 */
export interface DiskDeltaLog {
  append(entry: DeltaLogEntry): Promise<void>;
  /** Rows with `version` strictly greater than `fromVersion`, in order. */
  readSince(fromVersion: number): Promise<DeltaLogEntry[]>;
}

class DiskSpaceLogCoordinator {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `Space logs(${this.#store.canvasId}) belong to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  private requireSpace(): void {
    assertSpaceMutationAllowed(this.#workspacePath, this.#store.canvasId);
    if (!readDiskSpaceRecord(this.#store)) {
      throw new Error(
        `Space logs(${this.#store.canvasId}) cannot write logs for a missing Space`,
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
   * `createDiskSpaceWrite`, which documents what the contract
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
        `DiskDeltaLog(${this.#store.canvasId}) refusing delta version ` +
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

  async deleteChange(
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

  async putIntent(episode: IntentEpisode): Promise<void> {
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
 * Build the log-backed parts carried by one Space handle.
 *
 * Each facade is frozen and contains only its own operations. The shared
 * coordinator — and therefore its legacy store — is closure-private.
 */
export function createDiskSpaceLogs(store: CanvasStore): DiskSpaceLogs {
  const coordinator = new DiskSpaceLogCoordinator(store);

  const events: SpaceEvents = Object.freeze({
    read: (limit?: number) => coordinator.readEvents(limit),
    append: (entries: readonly NewCanvasEvent[]) =>
      coordinator.appendEvents(entries),
  });
  const changes: SpaceChanges = Object.freeze({
    read: (threadId: string) => coordinator.readChanges(threadId),
    append: (threadId: string, records: readonly CanvasChangeRecord[]) =>
      coordinator.appendChanges(threadId, records),
    delete: (threadId: string, changeId: string) =>
      coordinator.deleteChange(threadId, changeId),
  });
  const intents: SpaceIntents = Object.freeze({
    read: () => coordinator.readIntents(),
    put: (episode: IntentEpisode) => coordinator.putIntent(episode),
  });

  return Object.freeze({ events, changes, intents });
}

/** Open Disk's executor journal for one Space. */
export function createDiskDeltaLog(store: CanvasStore): DiskDeltaLog {
  const coordinator = new DiskSpaceLogCoordinator(store);
  return Object.freeze({
    append: (entry: DeltaLogEntry) => coordinator.appendDelta(entry),
    readSince: (fromVersion: number) =>
      coordinator.readDeltasSince(fromVersion),
  });
}
