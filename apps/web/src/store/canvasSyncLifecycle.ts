// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type CanvasSnapshotCatchupState = {
  canvasId: string;
  version: number;
  isLoading: boolean;
  structureDirtyGeneration: number;
  structureSyncedGeneration: number;
  pendingContentNodeIds: readonly string[];
};

/**
 * Retain the newest stream snapshot while a primary GET is in flight. When
 * that GET settles, a newer retained version triggers one authoritative
 * reload instead of being lost behind the loading guard.
 */
export function createCanvasSnapshotCatchup(opts: {
  getState: () => CanvasSnapshotCatchupState;
  reload: (canvasId: string) => void | Promise<void>;
}): {
  observe(canvasId: string, serverVersion: number): void | Promise<void>;
  reconcile(): void | Promise<void>;
  clear(): void;
} {
  let pending: { canvasId: string; version: number } | null = null;
  let reconcileInFlight: Promise<void> | null = null;

  const reconcile = (): void | Promise<void> => {
    if (reconcileInFlight) return reconcileInFlight;
    if (!pending) return;

    const state = opts.getState();
    if (state.canvasId !== pending.canvasId) {
      pending = null;
      return;
    }
    if (state.isLoading) return;
    if (pending.version <= state.version) {
      pending = null;
      return;
    }
    const hasUnsavedStructure =
      state.structureDirtyGeneration !== state.structureSyncedGeneration;
    if (hasUnsavedStructure || state.pendingContentNodeIds.length > 0) {
      // Preserve local-first work. A later store transition (save/flush) calls
      // reconcile again and heals from the retained newest snapshot.
      return;
    }

    const canvasId = pending.canvasId;
    const requestedVersion = pending.version;
    // Defer the reload one microtask so a Zustand `isLoading: false`
    // notification cannot re-enter loadCanvas before the finishing load has
    // seeded its baselines and cleared commit reconciliation state.
    reconcileInFlight = Promise.resolve()
      .then(() => opts.reload(canvasId))
      .finally(() => {
        reconcileInFlight = null;
        const stateAfterReload = opts.getState();
        if (
          pending?.canvasId === canvasId &&
          stateAfterReload.canvasId === canvasId &&
          pending.version <= stateAfterReload.version
        ) {
          pending = null;
          return;
        }
        // Retry immediately only when this reload made the requested progress
        // and a genuinely newer snapshot arrived during it. If the request
        // failed or returned another stale snapshot, retain the target for the
        // next stream/store signal instead of spinning a microtask retry loop.
        if (
          pending?.canvasId === canvasId &&
          pending.version > requestedVersion &&
          stateAfterReload.version >= requestedVersion
        ) {
          void reconcile();
        }
      });
    return reconcileInFlight;
  };

  return {
    observe(canvasId, serverVersion) {
      if (!pending || pending.canvasId !== canvasId) {
        pending = { canvasId, version: serverVersion };
      } else {
        pending.version = Math.max(pending.version, serverVersion);
      }
      return reconcile();
    },

    reconcile,

    clear() {
      pending = null;
    },
  };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Keep an SSE subscription alive across EOF and transient fetch/read errors.
 * Successful connections restart the backoff; consecutive failures grow to
 * a bounded delay. Every reconnect opens a fresh stream, whose initial
 * snapshot performs the normal version catch-up.
 */
export async function runCanvasSyncReconnectLoop(opts: {
  signal: AbortSignal;
  isActive: () => boolean;
  connectOnce: () => Promise<boolean>;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
}): Promise<void> {
  const initialDelayMs = opts.initialDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const wait = opts.wait ?? abortableDelay;
  let consecutiveFailures = 0;

  while (!opts.signal.aborted && opts.isActive()) {
    let connected = false;
    try {
      connected = await opts.connectOnce();
    } catch {
      connected = false;
    }
    if (opts.signal.aborted || !opts.isActive()) break;

    const delayMs = connected
      ? initialDelayMs
      : Math.min(initialDelayMs * 2 ** consecutiveFailures, maxDelayMs);
    consecutiveFailures = connected ? 0 : consecutiveFailures + 1;
    await wait(delayMs, opts.signal);
  }
}
