// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getSpacePreviewScene } from '@/api/canvas';

import type { GetSpacePreviewSceneResponse } from '@huabu/shared';

const FRESH_MS = 10_000;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_CACHE_ENTRIES = 50;

export interface SpacePreviewSceneSnapshot {
  scene: GetSpacePreviewSceneResponse | null;
  loading: boolean;
  stale: boolean;
  error: Error | null;
}

interface CacheEntry {
  snapshot: SpacePreviewSceneSnapshot;
  fetchedAt: number;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  touchedAt: number;
}

const entries = new Map<string, CacheEntry>();
const queue: Array<() => void> = [];
let activeRequests = 0;

function evictInactiveEntries(): void {
  while (entries.size >= MAX_CACHE_ENTRIES) {
    let oldest: { canvasId: string; entry: CacheEntry } | undefined;
    for (const [canvasId, entry] of entries) {
      if (entry.inFlight || entry.listeners.size > 0) continue;
      if (!oldest || entry.touchedAt < oldest.entry.touchedAt) {
        oldest = { canvasId, entry };
      }
    }
    if (!oldest) return;
    entries.delete(oldest.canvasId);
  }
}

function entryFor(canvasId: string): CacheEntry {
  let entry = entries.get(canvasId);
  if (!entry) {
    evictInactiveEntries();
    entry = {
      snapshot: { scene: null, loading: false, stale: false, error: null },
      fetchedAt: 0,
      listeners: new Set(),
      inFlight: null,
      touchedAt: Date.now(),
    };
    entries.set(canvasId, entry);
  } else {
    entry.touchedAt = Date.now();
  }
  return entry;
}

function publish(entry: CacheEntry, snapshot: SpacePreviewSceneSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function runQueued(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const next = queue.shift();
    if (!next) return;
    activeRequests += 1;
    next();
  }
}

export function loadSpacePreviewScene(
  canvasId: string,
  force = false,
): Promise<void> {
  const entry = entryFor(canvasId);
  if (entry.inFlight) return entry.inFlight;
  if (
    !force &&
    entry.fetchedAt > 0 &&
    Date.now() - entry.fetchedAt < FRESH_MS
  ) {
    return Promise.resolve();
  }

  publish(entry, {
    scene: entry.snapshot.scene,
    loading: entry.snapshot.scene === null,
    stale: entry.snapshot.scene !== null,
    error: null,
  });

  entry.inFlight = new Promise<void>((resolve) => {
    queue.push(() => {
      void getSpacePreviewScene(canvasId)
        .then((scene) => {
          entry.fetchedAt = Date.now();
          publish(entry, {
            scene,
            loading: false,
            stale: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          publish(entry, {
            scene: entry.snapshot.scene,
            loading: false,
            stale: entry.snapshot.scene !== null,
            error:
              error instanceof Error
                ? error
                : new Error('Failed to load Space preview'),
          });
        })
        .finally(() => {
          entry.inFlight = null;
          activeRequests -= 1;
          resolve();
          runQueued();
        });
    });
    runQueued();
  });

  return entry.inFlight;
}

export function useSpacePreviewScene(
  canvasId: string,
  enabled = true,
): SpacePreviewSceneSnapshot & { retry: () => void } {
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(canvasId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [canvasId],
  );
  const getSnapshot = useCallback(
    () => entryFor(canvasId).snapshot,
    [canvasId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled) return;
    void loadSpacePreviewScene(canvasId);
    const onFocus = () => void loadSpacePreviewScene(canvasId);
    const interval = window.setInterval(
      () => void loadSpacePreviewScene(canvasId),
      FRESH_MS,
    );
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [canvasId, enabled]);

  const retry = useCallback(() => {
    void loadSpacePreviewScene(canvasId, true);
  }, [canvasId]);

  return { ...snapshot, retry };
}

export function clearSpacePreviewSceneCache(): void {
  entries.clear();
}

export function getSpacePreviewSceneSnapshot(
  canvasId: string,
): SpacePreviewSceneSnapshot {
  return entryFor(canvasId).snapshot;
}

if (typeof window !== 'undefined') {
  window.addEventListener('workspace-changed', clearSpacePreviewSceneCache);
}
