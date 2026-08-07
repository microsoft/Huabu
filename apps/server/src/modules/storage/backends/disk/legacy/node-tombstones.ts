/**
 * Process-local guard against late node-sidecar writes after deletion.
 *
 * Tombstones cannot live on a {@link CanvasStore} instance: those instances
 * sit in a bounded LRU and may be evicted while an already-started writer is
 * still running. This registry is therefore shared by every instance, scoped
 * by both workspace and Space id, and expires entries after a short TTL.
 *
 * A single unref'd timer removes expired entries even when no later storage
 * call happens, so old workspaces and node ids do not become a permanent,
 * ever-growing process map.
 */

export const NODE_TOMBSTONE_TTL_MS = 5 * 60_000;

const tombstones = new Map<string, Map<string, number>>();
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

export interface NodeTombstoneSnapshot {
  readonly nodeIds: readonly string[];
  readonly expiresAtByNodeId: ReadonlyMap<string, number>;
}

function scopeKey(workspacePath: string, canvasId: string): string {
  // NUL cannot occur in a filesystem path or id, so the pair is unambiguous.
  return `${workspacePath}\0${canvasId}`;
}

function sweepExpired(now = Date.now()): void {
  for (const [scope, entries] of tombstones) {
    for (const [nodeId, expiresAt] of entries) {
      if (now >= expiresAt) entries.delete(nodeId);
    }
    if (entries.size === 0) tombstones.delete(scope);
  }
}

function scheduleCleanup(): void {
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  let earliest = Number.POSITIVE_INFINITY;
  for (const entries of tombstones.values()) {
    for (const expiresAt of entries.values()) {
      earliest = Math.min(earliest, expiresAt);
    }
  }
  if (!Number.isFinite(earliest)) return;

  const delay = Math.max(0, earliest - Date.now());
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    sweepExpired();
    scheduleCleanup();
  }, delay);
  // Expiry bookkeeping must never keep the server process alive on shutdown.
  (cleanupTimer as { unref?: () => void }).unref?.();
}

export function markNodeDeleted(
  workspacePath: string,
  canvasId: string,
  nodeId: string,
): void {
  sweepExpired();
  const scope = scopeKey(workspacePath, canvasId);
  let entries = tombstones.get(scope);
  if (!entries) {
    entries = new Map();
    tombstones.set(scope, entries);
  }
  entries.set(nodeId, Date.now() + NODE_TOMBSTONE_TTL_MS);
  scheduleCleanup();
}

export function clearNodeTombstone(
  workspacePath: string,
  canvasId: string,
  nodeId: string,
): void {
  const scope = scopeKey(workspacePath, canvasId);
  const entries = tombstones.get(scope);
  if (!entries) return;
  if (!entries.delete(nodeId)) return;
  if (entries.size === 0) tombstones.delete(scope);
  scheduleCleanup();
}

export function clearSpaceNodeTombstones(
  workspacePath: string,
  canvasId: string,
): void {
  tombstones.delete(scopeKey(workspacePath, canvasId));
  scheduleCleanup();
}

export function isNodeTombstoned(
  workspacePath: string,
  canvasId: string,
  nodeId: string,
): boolean {
  const scope = scopeKey(workspacePath, canvasId);
  const entries = tombstones.get(scope);
  const expiresAt = entries?.get(nodeId);
  if (expiresAt === undefined) return false;
  if (Date.now() < expiresAt) return true;

  entries?.delete(nodeId);
  if (entries?.size === 0) tombstones.delete(scope);
  scheduleCleanup();
  return false;
}

/** Capture exact process-local tombstone state for transaction rollback. */
export function captureNodeTombstones(
  workspacePath: string,
  canvasId: string,
  nodeIds: ReadonlySet<string>,
): NodeTombstoneSnapshot {
  sweepExpired();
  const ids = [...nodeIds];
  const entries = tombstones.get(scopeKey(workspacePath, canvasId));
  const expiresAtByNodeId = new Map<string, number>();
  for (const nodeId of ids) {
    const expiresAt = entries?.get(nodeId);
    if (expiresAt !== undefined) expiresAtByNodeId.set(nodeId, expiresAt);
  }
  return { nodeIds: ids, expiresAtByNodeId };
}

/** Restore only the ids captured by {@link captureNodeTombstones}. */
export function restoreNodeTombstones(
  workspacePath: string,
  canvasId: string,
  snapshot: NodeTombstoneSnapshot,
): void {
  const scope = scopeKey(workspacePath, canvasId);
  let entries = tombstones.get(scope);
  for (const nodeId of snapshot.nodeIds) entries?.delete(nodeId);

  if (snapshot.expiresAtByNodeId.size > 0) {
    if (!entries) {
      entries = new Map();
      tombstones.set(scope, entries);
    }
    for (const [nodeId, expiresAt] of snapshot.expiresAtByNodeId) {
      entries.set(nodeId, expiresAt);
    }
  }
  if (entries?.size === 0) tombstones.delete(scope);
  scheduleCleanup();
}
