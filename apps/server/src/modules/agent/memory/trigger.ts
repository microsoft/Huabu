// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory worker trigger state.
 *
 * Per-canvas bookkeeping for the memory sub-agent (`worker.ts`):
 *
 *   counter             how many user-driven canvas ops we've seen
 *                       since the last analysis pass; the worker is
 *                       enqueued when this crosses {@link OP_THRESHOLD}.
 *   lastAnalyzedAt      epoch ms of the last successful analysis;
 *                       null until the first pass lands.
 *   lastSeenThreadCursor retained compatibility field from the removed
 *                       legacy chat digest. Existing state files preserve it,
 *                       but current analysis passes do not advance it.
 *
 * Persisted on the storage extension substrate under the `huabu.memory`
 * namespace, so the counter survives process restarts. Storage hands this
 * module a place and nothing else — it never sees these three fields, and this
 * module owns the format, one small store per backend kind (proposal §6.4.4).
 * The state is kept tiny (<128 B) and atomic-written; read / write failures are
 * reported but never thrown — losing it at worst means we miss or duplicate
 * one analysis pass, which is harmless.
 */

import path from 'node:path';

import { atomicWriteJson, readJson } from '../../../utils/fs.js';
import { createKeyedMutex } from '../../../utils/keyed-mutex.js';
import { space } from '../../storage/index.js';

import type { SpaceSubstrate } from '../../storage/index.js';

/** This module's namespace on the substrate. */
const MEMORY_NAMESPACE = 'huabu.memory';

/**
 * Where this module keeps its state on a Disk substrate.
 *
 * The whole store, because the state is one whole-value rewrite. A key/value
 * member on the port would have covered exactly this and nothing else, for
 * every owner forever — which is why the port hands over a place instead
 * (§6.4.4). An owner that later wants the same shape extracts a helper *over*
 * the substrate, never a port member.
 */
function diskStatePath(substrate: SpaceSubstrate): string {
  if (substrate.kind !== 'disk') {
    throw new Error('Memory state requires a Disk extension substrate');
  }
  return path.join(substrate.directory, 'state.json');
}

/** Op-count threshold that triggers a memory analysis pass. */
export const OP_THRESHOLD = 50;

// Per-canvas mutex around state.json read-modify-write. Without it,
// concurrent mutating requests on the same canvas all read the same
// `counter` value, increment locally, and race the writes — so the
// counter advances by 1 instead of N. The same hazard applies to
// `markAnalyzed`, which clobbers any in-flight bump if unguarded.
const stateLock = createKeyedMutex<string>();

export interface MemoryState {
  counter: number;
  lastAnalyzedAt: number | null;
  lastSeenThreadCursor: number | null;
}

const EMPTY_STATE: MemoryState = {
  counter: 0,
  lastAnalyzedAt: null,
  lastSeenThreadCursor: null,
};

/**
 * Read the persisted memory state for a canvas.
 *
 * Returns a fresh-zero state when the file is missing, unparseable,
 * or carries unexpected types. The trigger module is "best effort":
 * we'd rather miscount a few ops than crash the request pipeline on
 * a corrupted bookkeeping file.
 */
export async function readMemoryState(canvasId: string): Promise<MemoryState> {
  const substrate = await space(canvasId).extension(MEMORY_NAMESPACE);
  if (!substrate) return { ...EMPTY_STATE };
  const raw = readJson<Partial<MemoryState>>(diskStatePath(substrate));
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  return {
    counter: typeof raw.counter === 'number' ? raw.counter : 0,
    lastAnalyzedAt:
      typeof raw.lastAnalyzedAt === 'number' ? raw.lastAnalyzedAt : null,
    lastSeenThreadCursor:
      typeof raw.lastSeenThreadCursor === 'number'
        ? raw.lastSeenThreadCursor
        : null,
  };
}

/**
 * Atomic write of the memory state.
 *
 * No resurrection guard of its own. The op-counter `onResponse` hook fires
 * *after* DELETE /api/canvas/:id has removed the Space, and this module used
 * to check the Space directory itself before writing — otherwise it would drop
 * a fresh `state.json` into a directory the delete had just removed, leaving a
 * stub Space behind. `extension()` refuses a substrate for a Space that is
 * gone, so the guard now lives in the one place that can state it for every
 * owner rather than being re-derived by each (proposal §12.6.3).
 */
export async function writeMemoryState(
  canvasId: string,
  state: MemoryState,
): Promise<void> {
  const substrate = await space(canvasId).extension(MEMORY_NAMESPACE);
  if (!substrate) return;
  atomicWriteJson(diskStatePath(substrate), state);
}

/**
 * Increment the canvas op counter and report whether the analysis
 * threshold has been crossed.
 *
 * On crossing the threshold the counter is reset to 0 in the same
 * write — callers may immediately enqueue the worker without worrying
 * about double-firing on the very next op batch.
 *
 * Serialized per canvas via {@link stateLock} so concurrent mutating
 * requests on the same canvas cannot lose increments via a
 * read-modify-write race.
 *
 * Returns `true` exactly when the worker should be enqueued.
 */
export async function bumpOpCounter(
  canvasId: string,
  delta: number,
): Promise<boolean> {
  if (!Number.isFinite(delta) || delta <= 0) return false;
  return stateLock(canvasId, async () => {
    const state = await readMemoryState(canvasId);
    state.counter += delta;
    if (state.counter < OP_THRESHOLD) {
      await writeMemoryState(canvasId, state);
      return false;
    }
    // Threshold crossed: reset and signal.
    state.counter = 0;
    await writeMemoryState(canvasId, state);
    return true;
  });
}

/**
 * Record that an analysis pass completed.
 *
 * Updates `lastAnalyzedAt` and (optionally) `lastSeenThreadCursor`
 * without touching the counter — the counter was already reset by
 * {@link bumpOpCounter} when it returned `true`.
 *
 * Shares {@link stateLock} with `bumpOpCounter` so a concurrent bump
 * cannot overwrite the cursor update (or vice versa).
 *
 * Used by `worker.ts` after a successful analysis (PR-C).
 */
export async function markAnalyzed(
  canvasId: string,
  opts: {
    lastSeenThreadCursor?: number;
  } = {},
): Promise<void> {
  await stateLock(canvasId, async () => {
    const state = await readMemoryState(canvasId);
    state.lastAnalyzedAt = Date.now();
    if (opts.lastSeenThreadCursor !== undefined) {
      state.lastSeenThreadCursor = opts.lastSeenThreadCursor;
    }
    await writeMemoryState(canvasId, state);
  });
}
