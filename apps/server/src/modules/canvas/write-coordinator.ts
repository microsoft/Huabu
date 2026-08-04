/**
 * Canvas write coordinator.
 *
 * Owns the **per-canvas async write lock** that serializes all durable
 * writes to a single Space's on-disk state (topology and its
 * `nodes/*.md` sidecars). A single promise per `canvasId` records the tail
 * of the in-flight task chain; new callers attach onto that tail. The chain
 * catches errors so one failed task does not poison subsequent ones, and the
 * map entry is cleaned up only when our own chain is still the head
 * (otherwise a newer schedule already extended it and owns the cleanup).
 *
 * This lock lives here (the Canvas domain) rather than in any one writer so
 * **every** writer — the agent executor, the per-node content write path, and
 * preprocessing — can share the same lock instead of each re-implementing its
 * own. It coordinates Canvas mutations and revision policy; it is not a
 * backend adapter, which is why it is not owned by `storage/`. It is
 * deliberately **mechanism only**: it owns serialization, not field-ownership
 * policy. Callers pass in what to write.
 *
 * Per-canvas (not per-node) granularity is intentional: an agent batch must
 * write topology and several `.md` files atomically under one lock, and
 * the critical section holds only microsecond-scale synchronous writes (any
 * expensive pipeline stays outside the lock).
 */

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import type { CanvasStore, NodeContent, RenameResult } from '../storage/index.js';

const canvasMutexChains = new Map<string, Promise<unknown>>();

export async function withCanvasMutex<T>(
  canvasId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = canvasMutexChains.get(canvasId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  canvasMutexChains.set(canvasId, next);
  try {
    return await next;
  } finally {
    if (canvasMutexChains.get(canvasId) === next) {
      canvasMutexChains.delete(canvasId);
    }
  }
}

/**
 * Outcome of an {@link updateNode} call.
 *  - `ok`            → the write landed; `rev` is the new CAS baseline
 *    (co-delivered with the write it confirms), `label` / `filename` are as
 *    actually persisted (including any ` (N)` dedupe suffix).
 *  - `rev-conflict`  → `expectRev` disagreed with the current on-disk rev;
 *    nothing was written (no clobber). `currentRev` is the on-disk baseline.
 *  - `noop`          → `apply` returned `null` (nothing to write).
 *  - `skipped-deleted` → the node is tombstoned (deleted moments ago) and
 *    absent from live structural state, so this write was a late in-flight
 *    resurrection and was dropped. `apply` is NOT invoked. See
 *    {@link CanvasStore.isNodeWriteSuppressed}.
 *  - `rejected`      → `writeNode` refused (label collision / duplicate
 *    sidecars / missing file); the raw store result is passed through so the
 *    caller maps it to its own error surface.
 */
export type UpdateNodeOutcome =
  | { status: 'ok'; rev: string; label: string | null; filename: string }
  | { status: 'rev-conflict'; currentRev: string }
  | { status: 'noop' }
  | { status: 'skipped-deleted' }
  | { status: 'rejected'; result: Extract<RenameResult, { ok: false }> };

export interface UpdateNodeOptions {
  /**
   * Optimistic-concurrency baseline. When provided and it disagrees with the
   * current on-disk rev, the update is refused (`rev-conflict`) — the guard
   * that stops a stale writer from clobbering a newer body. Omit it for
   * writers that own the field unconditionally (e.g. idempotent extraction).
   */
  expectRev?: string;
  /**
   * Compute the record to persist from the current on-disk record (`null`
   * when the node has no sidecar yet). Return `null` to make the update a
   * no-op. **Field-ownership policy lives here — in the caller** (label
   * precedence, body ownership, dedupe of unchanged content), not in the
   * coordinator, which stays mechanism-only. The returned value is a complete
   * {@link NodeContent} record (it replaces the sidecar).
   */
  apply: (current: NodeContent | null) => NodeContent | null;
  /** Forwarded to {@link CanvasStore.writeNode} — strict user-rename 409. */
  strictRename?: boolean;
}

/**
 * Serialized, rev-CAS-guarded write of a single node's `.md` sidecar.
 *
 * Runs the read → CAS → apply → write critical section under the shared
 * {@link withCanvasMutex} (keyed by `store.canvasId`), so it cannot interleave
 * with another `updateNode`, an agent executor batch, or any other writer that
 * takes the same lock. `readNode` / `writeNode` are synchronous, so the whole
 * critical section is `await`-free and therefore atomic within the lock.
 *
 * The `store` is injected (rather than looked up here) to keep this module
 * free of an import cycle with the storage index and to make it trivially
 * testable with a fake store.
 */
export async function updateNode(
  store: CanvasStore,
  nodeId: string,
  opts: UpdateNodeOptions,
): Promise<UpdateNodeOutcome> {
  return withCanvasMutex(store.canvasId, () =>
    Promise.resolve(applyNodeUpdate(store, nodeId, opts)),
  );
}

/**
 * Non-locking core of {@link updateNode}: the synchronous read → rev-CAS →
 * apply → write critical section, WITHOUT acquiring the canvas lock.
 *
 * ⚠️ The caller MUST already hold `withCanvasMutex(store.canvasId)`. This exists
 * for writers that run *inside* an existing canvas-lock critical section — the
 * agent executor, which locks its whole multi-node topology batch and
 * would **deadlock** on a re-entrant `updateNode` (the promise-chain mutex is
 * not re-entrant). Every writer that does NOT already hold the lock must use
 * {@link updateNode} instead.
 */
export function applyNodeUpdate(
  store: CanvasStore,
  nodeId: string,
  opts: UpdateNodeOptions,
): UpdateNodeOutcome {
  // Tombstone guard: a node deleted moments ago must not be resurrected on
  // disk by a late in-flight write (an already-sent content PUT or a slow
  // preprocessing run that finished after the DELETE). Checked before the
  // read/CAS/apply so no stale work is done. `apply` is intentionally NOT
  // invoked, so callers that derive their result from `apply`'s side effects
  // (e.g. the preprocessing persist stage) naturally treat this as a no-op.
  if (store.isNodeWriteSuppressed(nodeId)) {
    return { status: 'skipped-deleted' };
  }

  const current = store.readNode(nodeId);

  if (opts.expectRev !== undefined) {
    const currentRev = revOf(current);
    if (opts.expectRev !== currentRev) {
      return { status: 'rev-conflict', currentRev };
    }
  }

  const next = opts.apply(current);
  if (next === null) return { status: 'noop' };

  const result = store.writeNode(nodeId, next, {
    strictRename: opts.strictRename,
  });
  if (!result.ok) return { status: 'rejected', result };

  return {
    status: 'ok',
    rev: revOf(next),
    label: result.label,
    filename: result.filename,
  };
}

/** rev of a node record from its CAS-relevant fields (`content` + `src`). */
function revOf(rec: NodeContent | null): string {
  return nodeRevisionOf({
    ...(typeof rec?.content === 'string' ? { content: rec.content } : {}),
    ...(typeof rec?.src === 'string' ? { src: rec.src } : {}),
  });
}
