// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';
import { create } from 'zustand';

import { querySpaceCards } from '@/api/spaceCard';
import { useWorkspaceStore } from '@/store/workspaceStore';

import type { SpaceCardSnapshot } from '@huabu/shared';

const useSnapshots = create<{ spaces: Record<string, SpaceCardSnapshot> }>(
  () => ({ spaces: {} }),
);
const targets = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let unsubscribeWorkspace: (() => void) | undefined;

function schedule(delay = 0) {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), delay);
}

async function refresh() {
  const workspace = useWorkspaceStore.getState();
  if (
    document.hidden ||
    !workspace.isReady ||
    workspace.isSyncing ||
    !targets.size
  )
    return;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const ids = [...targets.keys()];
  try {
    // Bound request and storage concurrency even on a large World canvas.
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      try {
        const result = await querySpaceCards(batch, request.signal);
        if (request.signal.aborted) return;
        useSnapshots.setState((state) => {
          const spaces = { ...state.spaces };
          for (const [id, next] of Object.entries(result.spaces)) {
            if (JSON.stringify(spaces[id]) !== JSON.stringify(next))
              spaces[id] = next;
          }
          return { spaces };
        });
        const current = useWorkspaceStore.getState();
        for (const [id, snapshot] of Object.entries(result.spaces)) {
          if (
            snapshot.status === 'ready' &&
            current.spaceTitles[id] !== snapshot.title
          ) {
            current.setSpaceTitle(id, snapshot.title);
          }
        }
      } catch (error) {
        if (request.signal.aborted) return;
        console.error('Space activity refresh failed', error);
        useSnapshots.setState((state) => ({
          spaces: {
            ...state.spaces,
            ...Object.fromEntries(batch.map((id) => [id, { status: 'error' }])),
          },
        }));
      }
    }
  } finally {
    if (controller === request) {
      controller = undefined;
      if (targets.size && !document.hidden) schedule(5_000);
    }
  }
}

export function refreshSpaceCardActivity() {
  controller?.abort();
  controller = undefined;
  schedule();
}

function visibilityChanged() {
  controller?.abort();
  controller = undefined;
  clearTimeout(timer);
  if (!document.hidden) schedule();
}

export function useSpaceCardActivity(canvasId: string, enabled: boolean) {
  const snapshot = useSnapshots((state) => state.spaces[canvasId]);
  useEffect(() => {
    if (!enabled) return;
    targets.set(canvasId, (targets.get(canvasId) ?? 0) + 1);
    if (targets.size === 1 && !unsubscribeWorkspace) {
      document.addEventListener('visibilitychange', visibilityChanged);
      window.addEventListener('focus', refreshSpaceCardActivity);
      unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previous) => {
        if (
          state.workspaceId !== previous.workspaceId ||
          state.isSyncing !== previous.isSyncing ||
          state.isReady !== previous.isReady
        ) {
          controller?.abort();
          controller = undefined;
          useSnapshots.setState({ spaces: {} });
          schedule();
        }
      });
    }
    if (targets.get(canvasId) === 1) schedule();
    return () => {
      const count = targets.get(canvasId) ?? 1;
      if (count > 1) targets.set(canvasId, count - 1);
      else targets.delete(canvasId);
      if (!targets.size) {
        clearTimeout(timer);
        controller?.abort();
        controller = undefined;
        unsubscribeWorkspace?.();
        unsubscribeWorkspace = undefined;
        document.removeEventListener('visibilitychange', visibilityChanged);
        window.removeEventListener('focus', refreshSpaceCardActivity);
        useSnapshots.setState({ spaces: {} });
      }
    };
  }, [canvasId, enabled]);
  return enabled ? snapshot : undefined;
}
