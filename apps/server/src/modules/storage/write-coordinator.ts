/**
 * Canvas write coordinator.
 *
 * Owns the **per-canvas async write lock** that serializes all durable
 * writes to a single canvas's on-disk state (`canvas.json` and its
 * `nodes/*.md` sidecars). A single promise per `canvasId` records the tail
 * of the in-flight task chain; new callers attach onto that tail. The chain
 * catches errors so one failed task does not poison subsequent ones, and the
 * map entry is cleaned up only when our own chain is still the head
 * (otherwise a newer schedule already extended it and owns the cleanup).
 *
 * This lock lives here (the storage layer) rather than in any one domain
 * module so **every** writer — the agent executor, the per-node content
 * write path, and preprocessing — can share the same lock instead of each
 * re-implementing its own. It is deliberately **mechanism only**: it owns
 * serialization, not field-ownership policy. Callers pass in what to write.
 *
 * Per-canvas (not per-node) granularity is intentional: an agent batch must
 * write `canvas.json` and several `.md` files atomically under one lock, and
 * the critical section holds only microsecond-scale synchronous writes (any
 * expensive pipeline stays outside the lock).
 */

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
