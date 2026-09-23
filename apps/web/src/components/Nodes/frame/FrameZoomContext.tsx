// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStoreApi } from '@xyflow/react';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  EMPTY_FRAME_ZOOM,
  resolveFrameZoom,
  type FrameZoomSnapshot,
} from './frameZoom';

const createFrameZoomStore = () =>
  createStore<FrameZoomSnapshot>(() => EMPTY_FRAME_ZOOM);
const fallback = createFrameZoomStore();
const FrameZoomContext = createContext(fallback);

/** Per-canvas ephemeral state; previews and other canvases cannot affect each other. */
export function FrameZoomProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createFrameZoomStore);
  return (
    <FrameZoomContext.Provider value={store}>
      {children}
    </FrameZoomContext.Provider>
  );
}

export function useFrameRegionVisible(id: string) {
  return useStore(useContext(FrameZoomContext), (state) =>
    state.visible.has(id),
  );
}

export function useFrameSuppressed(id: string) {
  return useStore(useContext(FrameZoomContext), (state) =>
    state.suppressed.has(id),
  );
}

export function useFrameRegionZ(id: string) {
  return useStore(
    useContext(FrameZoomContext),
    (state) => state.regionZ.get(id) ?? 0,
  );
}

/** Only internal edges share a region; cross-region connections stay unchanged. */
export function useFrameInternalEdge(source: string, target: string) {
  return useStore(useContext(FrameZoomContext), (state) => {
    const region = state.regionByNode.get(source);
    return region !== undefined && region === state.regionByNode.get(target);
  });
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** One subscription per React Flow instance, not a tree scan in every node. */
export function FrameZoomController({
  scopeKey,
}: {
  scopeKey?: string | null;
}) {
  const flow = useStoreApi();
  const store = useContext(FrameZoomContext);
  useLayoutEffect(() => {
    let lastNodes: ReturnType<typeof flow.getState>['nodes'] | undefined;
    let lastZoom: number | undefined;
    const update = () => {
      const state = flow.getState();
      const zoom = state.transform[2];
      if (lastNodes === state.nodes && lastZoom === zoom) return;
      lastNodes = state.nodes;
      lastZoom = zoom;
      const previous = store.getState();
      const next = resolveFrameZoom(state.nodes, zoom, previous);
      if (
        !sameSet(previous.active, next.active) ||
        !sameSet(previous.visible, next.visible) ||
        !sameSet(previous.suppressed, next.suppressed) ||
        previous.regionByNode.size !== next.regionByNode.size ||
        [...next.regionByNode].some(
          ([id, owner]) => previous.regionByNode.get(id) !== owner,
        ) ||
        previous.regionZ.size !== next.regionZ.size ||
        [...next.regionZ].some(([id, z]) => previous.regionZ.get(id) !== z)
      )
        store.setState(next, true);
    };
    update();
    const unsubscribe = flow.subscribe(update);
    return () => {
      unsubscribe();
      store.setState(EMPTY_FRAME_ZOOM, true);
    };
  }, [flow, store, scopeKey]);
  return null;
}
