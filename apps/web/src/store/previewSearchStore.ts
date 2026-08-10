// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

interface PreviewSearchState {
  nodeId: string | null;
  query: string;
  isOpen: boolean;
  open: (nodeId: string) => void;
  close: () => void;
  setQuery: (query: string) => void;
}

export const usePreviewSearchStore = create<PreviewSearchState>((set) => ({
  nodeId: null,
  query: '',
  isOpen: false,
  open: (nodeId) => set({ nodeId, query: '', isOpen: true }),
  close: () => set({ nodeId: null, query: '', isOpen: false }),
  setQuery: (query) => set({ query }),
}));
