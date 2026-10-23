// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import type { CanvasSearchSource } from '@huabu/shared';

const renderers = new Map<string, Map<symbol, { active: boolean }>>();

function latestRenderer(nodeId: string): symbol | null {
  return (
    Array.from(renderers.get(nodeId) ?? [])
      .filter(([, entry]) => entry.active)
      .at(-1)?.[0] ?? null
  );
}

interface PreviewSearchState {
  nodeId: string | null;
  query: string;
  isOpen: boolean;
  focusInput: boolean;
  rendererOwner: symbol | null;
  navigationRequest: {
    occurrenceIndex: number;
    nonce: number;
    source?: CanvasSearchSource;
  } | null;
  navigationSequence: number;
  open: (nodeId: string) => void;
  reveal: (
    nodeId: string,
    query: string,
    occurrenceIndex: number,
    source?: CanvasSearchSource,
  ) => void;
  registerRenderer: (nodeId: string, owner: symbol) => () => void;
  consumeNavigation: (nonce: number) => void;
  close: () => void;
  setQuery: (query: string) => void;
}

export const usePreviewSearchStore = create<PreviewSearchState>((set, get) => ({
  nodeId: null,
  query: '',
  isOpen: false,
  focusInput: false,
  navigationRequest: null,
  navigationSequence: 0,
  rendererOwner: null,
  registerRenderer: (nodeId, owner) => {
    let owners = renderers.get(nodeId);
    if (!owners) {
      owners = new Map();
      renderers.set(nodeId, owners);
    }
    const registration = { active: true };
    owners.delete(owner);
    owners.set(owner, registration);
    if (get().nodeId === nodeId) set({ rendererOwner: owner });
    return () => {
      registration.active = false;
      // Effect replay renews the registration before this disposal checkpoint.
      queueMicrotask(() => {
        const current = renderers.get(nodeId);
        if (current?.get(owner) !== registration) return;
        current.delete(owner);
        if (current.size === 0) renderers.delete(nodeId);
        const state = get();
        if (state.nodeId !== nodeId || state.rendererOwner !== owner) return;
        const remaining = latestRenderer(nodeId);
        if (remaining) set({ rendererOwner: remaining });
        else state.close();
      });
    };
  },
  open: (nodeId) =>
    set({
      nodeId,
      query: '',
      isOpen: true,
      focusInput: true,
      navigationRequest: null,
      rendererOwner: latestRenderer(nodeId),
    }),
  reveal: (nodeId, query, occurrenceIndex, source) =>
    set((state) => {
      const nonce = state.navigationSequence + 1;
      return {
        nodeId,
        query: query.trim(),
        isOpen: true,
        focusInput: false,
        navigationSequence: nonce,
        navigationRequest: { occurrenceIndex, nonce, source },
        rendererOwner: latestRenderer(nodeId),
      };
    }),
  consumeNavigation: (nonce) =>
    set((state) =>
      state.navigationRequest?.nonce === nonce
        ? { navigationRequest: null }
        : {},
    ),
  close: () =>
    set({
      nodeId: null,
      query: '',
      isOpen: false,
      focusInput: false,
      navigationRequest: null,
      rendererOwner: null,
    }),
  setQuery: (query) => set({ query, navigationRequest: null }),
}));
