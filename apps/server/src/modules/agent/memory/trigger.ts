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
 *   lastSeenThreadCursor pi-ai context timestamp of the last
 *                       analysed chat turn — lets `context.ts` (PR-C)
 *                       only pull "new" turns into the analysis prompt.
 *   lastSeenIntentCursor epoch ms of the last analysed intent episode.
 *
 * Persisted at `<canvasDir>/.memory/state.json` so the counter
 * survives process restarts. The file is kept tiny (<128 B) and
 * atomic-written; read / write failures are reported but never thrown
 * — losing this state at worst means we miss or duplicate one
 * analysis pass, which is harmless.
 */

import { existsSync } from 'node:fs';

import { atomicWriteJson, mkdirp, readJson } from '../../../utils/fs.js';
import { createKeyedMutex } from '../../../utils/keyed-mutex.js';
import {
  memoryStatePath,
  canvasMemoryDir,
  canvasRoot,
} from '../../storage/paths.js';

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
  lastSeenIntentCursor: number | null;
}

const EMPTY_STATE: MemoryState = {
  counter: 0,
  lastAnalyzedAt: null,
  lastSeenThreadCursor: null,
  lastSeenIntentCursor: null,
};

/**
 * Read the persisted memory state for a canvas.
 *
 * Returns a fresh-zero state when the file is missing, unparseable,
 * or carries unexpected types. The trigger module is "best effort":
 * we'd rather miscount a few ops than crash the request pipeline on
 * a corrupted bookkeeping file.
 */
export function readMemoryState(canvasId: string): MemoryState {
  if (!existsSync(memoryStatePath(canvasId))) return { ...EMPTY_STATE };
  const raw = readJson<Partial<MemoryState>>(memoryStatePath(canvasId));
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  return {
    counter: typeof raw.counter === 'number' ? raw.counter : 0,
    lastAnalyzedAt:
      typeof raw.lastAnalyzedAt === 'number' ? raw.lastAnalyzedAt : null,
    lastSeenThreadCursor:
      typeof raw.lastSeenThreadCursor === 'number'
        ? raw.lastSeenThreadCursor
        : null,
    lastSeenIntentCursor:
      typeof raw.lastSeenIntentCursor === 'number'
        ? raw.lastSeenIntentCursor
        : null,
  };
}

/** Atomic write of the memory state, creating `.memory/` on demand. */
export function writeMemoryState(canvasId: string, state: MemoryState): void {
  // Resurrection guard: the op-counter `onResponse` hook fires
  // *after* DELETE /api/canvas/:id has rm -rf'd the canvas dir, and
  // would otherwise mkdirp `.memory/` + drop a fresh `state.json`
  // here \u2014 leaving behind a stub canvas dir containing only that
  // file. Same hazard for any in-flight memory worker that calls
  // `markAnalyzed` post-delete. Skip the write when the canvas root
  // is gone; losing one bookkeeping write is harmless.
  if (!existsSync(canvasRoot(canvasId))) return;
  mkdirp(canvasMemoryDir(canvasId));
  atomicWriteJson(memoryStatePath(canvasId), state);
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
  return stateLock(canvasId, () => {
    const state = readMemoryState(canvasId);
    state.counter += delta;
    if (state.counter < OP_THRESHOLD) {
      writeMemoryState(canvasId, state);
      return false;
    }
    // Threshold crossed: reset and signal.
    state.counter = 0;
    writeMemoryState(canvasId, state);
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
    lastSeenIntentCursor?: number;
  } = {},
): Promise<void> {
  await stateLock(canvasId, () => {
    const state = readMemoryState(canvasId);
    state.lastAnalyzedAt = Date.now();
    if (opts.lastSeenThreadCursor !== undefined) {
      state.lastSeenThreadCursor = opts.lastSeenThreadCursor;
    }
    if (opts.lastSeenIntentCursor !== undefined) {
      state.lastSeenIntentCursor = opts.lastSeenIntentCursor;
    }
    writeMemoryState(canvasId, state);
  });
}
