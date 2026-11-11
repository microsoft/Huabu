// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementations of the append-structured Space parts: events and
 * change-review records.
 *
 * The implementation stays co-located because both share the same legacy
 * per-Space object and workspace-lifetime guard. Callers receive frozen,
 * runtime-narrow facades rather than this coordinator, so no part can reach
 * unrelated methods or the legacy object.
 *
 * The executor journal (`delta-log.jsonl`) is deliberately absent. It is not a
 * part of a Space that `SpaceHandle` exposes, nothing reads it back, and the
 * write that produces a row takes it as an argument — so the row is appended
 * inside the ordered Space write (`space-write.ts`) rather than through a
 * repository here. A journal adapter with no caller could only be kept honest
 * by its own tests.
 */

import path from 'node:path';

import { canvasEventInputSchema, canvasEventRecordSchema } from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { changesPath, eventsPath } from './layout.js';
import { readDiskSpaceRecord } from './space-record.js';
import {
  atomicWriteJson,
  readJsonLinesStrict,
  readJsonStrict,
} from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';
import { assertSpaceMutationAllowed } from '../../space-lifecycle-admission.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasEvent } from '../../../canvas/persistence-types.js';
import type {
  NewCanvasEvent,
  SpaceChanges,
  SpaceEvents,
} from '../../ports/structured.js';
import type { z } from 'zod';

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

/** One thread's stored Review list, coalesced. */
export function readDiskChanges(
  canvasId: string,
  threadId: string,
): CanvasChangeRecord[] {
  return coalesceChanges(
    readJsonArray<CanvasChangeRecord>(
      changesPath(canvasId, threadId),
      'change-review records',
    ),
  );
}

/**
 * `records` folded into what the thread already holds — the list an append
 * stores. Pure with respect to the file: the caller decides when to write it,
 * which lets the Space write compute it before it commits anything.
 */
export function mergeDiskChanges(
  existing: readonly CanvasChangeRecord[],
  records: readonly CanvasChangeRecord[],
): CanvasChangeRecord[] {
  return coalesceChanges([...existing, ...records]);
}

/** Replace one thread's stored Review list. */
export function writeDiskChanges(
  canvasId: string,
  threadId: string,
  merged: readonly CanvasChangeRecord[],
): void {
  atomicWriteJson(changesPath(canvasId, threadId), merged);
}

export interface DiskSpaceLogs {
  readonly events: SpaceEvents;
  readonly changes: SpaceChanges;
}

class DiskSpaceLogCoordinator {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;
  readonly #recover: () => void;

  constructor(store: CanvasStore, recover: () => void) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
    this.#recover = recover;
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

  // ── Change-review records ─────────────────────────────────────────────────

  // A Space write can carry Review records. If one was interrupted, its
  // intent still holds the list it meant to store, and finishing it later
  // would overwrite whatever happens here — so it is finished first.

  async readChanges(threadId: string): Promise<CanvasChangeRecord[]> {
    this.assertActiveWorkspace();
    try {
      this.#recover();
    } catch {
      // Recovery writes, and is refused while the Space is being deleted. A
      // read then serves what is stored.
    }
    return readDiskChanges(this.#store.canvasId, threadId);
  }

  async appendChanges(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]> {
    this.assertActiveWorkspace();
    this.requireSpace();
    this.#recover();
    const canvasId = this.#store.canvasId;
    const merged = mergeDiskChanges(
      readDiskChanges(canvasId, threadId),
      records,
    );
    writeDiskChanges(canvasId, threadId, merged);
    return merged;
  }

  async deleteChange(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null> {
    this.assertActiveWorkspace();
    this.requireSpace();
    this.#recover();
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
}

/**
 * Build the log-backed parts carried by one Space handle.
 *
 * Each facade is frozen and contains only its own operations. The shared
 * coordinator — and therefore its legacy store — is closure-private.
 *
 * @param recover Finishes an interrupted Space write (see `space-save.ts`);
 *   the handle supplies it, and Review reads and writes call it first.
 */
export function createDiskSpaceLogs(
  store: CanvasStore,
  recover: () => void = () => {},
): DiskSpaceLogs {
  const coordinator = new DiskSpaceLogCoordinator(store, recover);

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
  return Object.freeze({ events, changes });
}
