// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Durable guard against late node-sidecar writes after deletion.
 *
 * Tombstones cannot live on a {@link CanvasStore} instance: those instances
 * sit in a bounded LRU and may be evicted while an already-started writer is
 * still running. This registry is therefore shared by every instance, scoped
 * by both workspace and Space id, and expires entries after a short TTL.
 *
 * The hot registry is mirrored under `<workspace>/.huabu/tombstones/`, so an
 * LRU eviction or server restart cannot erase the anti-resurrection window.
 * A single unref'd timer removes loaded expired entries; an unloaded durable
 * scope is swept lazily the first time that Space is touched.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../../../../../utils/fs.js';
import {
  workspaceHuabuDir,
  workspaceTombstonesDir,
} from '../../../../workspace/disk/paths.js';

export const NODE_TOMBSTONE_TTL_MS = 5 * 60_000;
export const NODE_TOMBSTONE_EMPTY_SCOPE_CACHE_MAX = 256;
export const NODE_TOMBSTONE_CLEANUP_RETRY_BASE_MS = 1_000;
export const NODE_TOMBSTONE_CLEANUP_RETRY_MAX_MS = 60_000;

const tombstones = new Map<string, Map<string, number>>();
const loadedScopes = new Set<string>();
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupRetryDelayMs = NODE_TOMBSTONE_CLEANUP_RETRY_BASE_MS;

export interface NodeTombstoneSnapshot {
  readonly nodeIds: readonly string[];
  readonly expiresAtByNodeId: ReadonlyMap<string, number>;
}

/** @internal Registry observability for bounded-cache/timer tests. */
export function nodeTombstoneRegistryStatsForTesting(
  workspacePath: string,
  canvasId: string,
): {
  readonly loadedScopeCount: number;
  readonly liveScopeCount: number;
  readonly scopeLoaded: boolean;
  readonly scopeLive: boolean;
} {
  const scope = scopeKey(workspacePath, canvasId);
  return {
    loadedScopeCount: loadedScopes.size,
    liveScopeCount: tombstones.size,
    scopeLoaded: loadedScopes.has(scope),
    scopeLive: tombstones.has(scope),
  };
}

function scopeKey(workspacePath: string, canvasId: string): string {
  // NUL cannot occur in a filesystem path or id, so the pair is unambiguous.
  return `${workspacePath}\0${canvasId}`;
}

interface DurableNodeTombstones {
  readonly version: 1;
  readonly canvasId: string;
  readonly entries: readonly (readonly [nodeId: string, expiresAt: number])[];
}

function scopeParts(scope: string): {
  workspacePath: string;
  canvasId: string;
} {
  const separator = scope.indexOf('\0');
  if (separator < 0) throw new Error('Invalid node tombstone scope');
  return {
    workspacePath: scope.slice(0, separator),
    canvasId: scope.slice(separator + 1),
  };
}

function durablePath(workspacePath: string, canvasId: string): string {
  const digest = createHash('sha256').update(canvasId, 'utf8').digest('hex');
  return path.join(workspaceTombstonesDir(workspacePath), `${digest}.json`);
}

function readDurableEntries(
  workspacePath: string,
  canvasId: string,
): Map<string, number> {
  const filePath = durablePath(workspacePath, canvasId);
  if (!existsSync(filePath)) return new Map();

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    const failure = new Error(
      `Unreadable durable node tombstones for ${canvasId}`,
    );
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  const record = value as Partial<DurableNodeTombstones> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    record.version !== 1 ||
    record.canvasId !== canvasId ||
    !Array.isArray(record.entries)
  ) {
    throw new Error(`Malformed durable node tombstones for ${canvasId}`);
  }

  const entries = new Map<string, number>();
  for (const item of record.entries) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== 'string' ||
      item[0].length === 0 ||
      typeof item[1] !== 'number' ||
      !Number.isSafeInteger(item[1]) ||
      item[1] < 0
    ) {
      throw new Error(`Malformed durable node tombstones for ${canvasId}`);
    }
    entries.set(item[0], item[1]);
  }
  return entries;
}

function entriesFor(
  workspacePath: string,
  canvasId: string,
): Map<string, number> {
  const scope = scopeKey(workspacePath, canvasId);
  if (!loadedScopes.has(scope)) {
    const entries = readDurableEntries(workspacePath, canvasId);
    if (entries.size > 0) {
      tombstones.set(scope, entries);
      rememberLoadedScope(scope);
      // A restarted process must not rely on another read to expire durable
      // suppression metadata that it has just admitted to the hot cache.
      scheduleCleanup();
    } else {
      rememberLoadedScope(scope);
    }
  }
  return tombstones.get(scope) ?? new Map();
}

/** Retain live scopes and a bounded LRU-style negative cache. */
function rememberLoadedScope(scope: string): void {
  loadedScopes.delete(scope);
  loadedScopes.add(scope);

  let emptyCount = 0;
  for (const candidate of loadedScopes) {
    if (!tombstones.has(candidate)) emptyCount += 1;
  }
  if (emptyCount <= NODE_TOMBSTONE_EMPTY_SCOPE_CACHE_MAX) return;

  for (const candidate of loadedScopes) {
    if (tombstones.has(candidate)) continue;
    loadedScopes.delete(candidate);
    emptyCount -= 1;
    if (emptyCount <= NODE_TOMBSTONE_EMPTY_SCOPE_CACHE_MAX) break;
  }
}

function cacheScope(
  scope: string,
  entries: Map<string, number>,
  retainEmpty: boolean,
): void {
  if (entries.size > 0) {
    tombstones.set(scope, entries);
    rememberLoadedScope(scope);
    return;
  }
  tombstones.delete(scope);
  if (retainEmpty) rememberLoadedScope(scope);
  else loadedScopes.delete(scope);
}

function persistScope(
  scope: string,
  entries: ReadonlyMap<string, number>,
): void {
  const { workspacePath, canvasId } = scopeParts(scope);
  const filePath = durablePath(workspacePath, canvasId);
  if (entries.size === 0) {
    rmSync(filePath, { force: true });
    return;
  }

  const huabuDir = workspaceHuabuDir(workspacePath);
  const tombstonesDir = workspaceTombstonesDir(workspacePath);
  mkdirSync(huabuDir, { recursive: true });
  mkdirSync(tombstonesDir, { recursive: true });
  const value: DurableNodeTombstones = {
    version: 1,
    canvasId,
    entries: [...entries].sort(([left], [right]) => left.localeCompare(right)),
  };
  atomicWriteJson(filePath, value);
}

function sweepExpired(now = Date.now()): void {
  for (const [scope, entries] of tombstones) {
    const retained = new Map(entries);
    for (const [nodeId, expiresAt] of entries) {
      if (now >= expiresAt) {
        retained.delete(nodeId);
      }
    }
    if (retained.size === entries.size) continue;

    // Persist before changing the hot cache. If cleanup fails, the expired
    // entries remain present so the timer can retry instead of losing the
    // only record of which durable file still needs removal.
    persistScope(scope, retained);
    cacheScope(scope, retained, false);
  }
}

function scheduleCleanup(retryDelayMs?: number): void {
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  let delay: number;
  if (retryDelayMs !== undefined) {
    delay = retryDelayMs;
  } else {
    let earliest = Number.POSITIVE_INFINITY;
    for (const entries of tombstones.values()) {
      for (const expiresAt of entries.values()) {
        earliest = Math.min(earliest, expiresAt);
      }
    }
    if (!Number.isFinite(earliest)) return;
    delay = Math.max(0, earliest - Date.now());
  }

  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    try {
      sweepExpired();
      cleanupRetryDelayMs = NODE_TOMBSTONE_CLEANUP_RETRY_BASE_MS;
      scheduleCleanup();
    } catch {
      // Timer callbacks must never surface an uncaught filesystem exception.
      // Keep the still-cached expired scope and retry with capped exponential
      // backoff; an ordinary API access may also complete cleanup sooner.
      const delayForRetry = cleanupRetryDelayMs;
      cleanupRetryDelayMs = Math.min(
        cleanupRetryDelayMs * 2,
        NODE_TOMBSTONE_CLEANUP_RETRY_MAX_MS,
      );
      scheduleCleanup(delayForRetry);
    }
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
  const entries = entriesFor(workspacePath, canvasId);
  const next = new Map(entries);
  next.set(nodeId, Date.now() + NODE_TOMBSTONE_TTL_MS);
  persistScope(scope, next);
  cacheScope(scope, next, true);
  scheduleCleanup();
}

export function clearNodeTombstone(
  workspacePath: string,
  canvasId: string,
  nodeId: string,
): void {
  const scope = scopeKey(workspacePath, canvasId);
  const entries = entriesFor(workspacePath, canvasId);
  if (!entries.has(nodeId)) return;
  const next = new Map(entries);
  next.delete(nodeId);
  persistScope(scope, next);
  cacheScope(scope, next, true);
  scheduleCleanup();
}

export function clearSpaceNodeTombstones(
  workspacePath: string,
  canvasId: string,
): void {
  const scope = scopeKey(workspacePath, canvasId);
  const empty = new Map<string, number>();
  persistScope(scope, empty);
  cacheScope(scope, empty, true);
  scheduleCleanup();
}

export function isNodeTombstoned(
  workspacePath: string,
  canvasId: string,
  nodeId: string,
): boolean {
  const scope = scopeKey(workspacePath, canvasId);
  const entries = entriesFor(workspacePath, canvasId);
  const expiresAt = entries?.get(nodeId);
  if (expiresAt === undefined) return false;
  if (Date.now() < expiresAt) return true;

  const next = new Map(entries);
  next.delete(nodeId);
  persistScope(scope, next);
  cacheScope(scope, next, false);
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
  const entries = entriesFor(workspacePath, canvasId);
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
  const entries = entriesFor(workspacePath, canvasId);
  const next = new Map(entries);
  for (const nodeId of snapshot.nodeIds) next.delete(nodeId);

  if (snapshot.expiresAtByNodeId.size > 0) {
    for (const [nodeId, expiresAt] of snapshot.expiresAtByNodeId) {
      next.set(nodeId, expiresAt);
    }
  }
  persistScope(scope, next);
  cacheScope(scope, next, true);
  scheduleCleanup();
}
