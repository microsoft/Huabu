// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import type { CanvasNodeType } from '@huabu/shared';

/**
 * A card that stands where an imported file's node will appear while the
 * file uploads. It lives only in this tab: it is never saved or synced, and
 * the real node replaces it once the upload finishes.
 */
export interface ImportPlaceholder {
  id: string;
  canvasId: string;
  nodeType: CanvasNodeType;
  name: string;
  /** Flow-space rectangle the node is expected to take. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Object URL of the local image, shown until the upload finishes. */
  previewUrl?: string;
  /** Set when the upload failed; the card then offers retry and remove. */
  error?: string;
  retry?: () => void;
}

interface ImportPlaceholderState {
  placeholders: ImportPlaceholder[];
  show: (placeholder: ImportPlaceholder) => void;
  update: (id: string, patch: Partial<ImportPlaceholder>) => void;
  remove: (id: string) => void;
}

export const useImportPlaceholderStore = create<ImportPlaceholderState>(
  (set, get) => ({
    placeholders: [],
    show: (placeholder) =>
      set({ placeholders: [...get().placeholders, placeholder] }),
    update: (id, patch) =>
      set({
        placeholders: get().placeholders.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      }),
    remove: (id) => {
      const removed = get().placeholders.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      set({
        placeholders: get().placeholders.filter((item) => item !== removed),
      });
    },
  }),
);
