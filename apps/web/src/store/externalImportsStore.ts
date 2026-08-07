// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { readTypedSSEStream } from '@/api/_sse';
import { externalStreamUrl, importExternalNote } from '@/api/externalImports';
import useCanvasStore from '@/store/canvasStore';

import type { ExternalNoteEvent, ExternalNoteItem } from '@huabu/shared';

interface ExternalImportsState {
  pending: ExternalNoteItem[];
  canvasId: string | null;
  connect: (canvasId: string) => void;
  disconnect: () => void;
  importItem: (item: ExternalNoteItem) => Promise<void>;
}

let abortController: AbortController | null = null;

function sortByMtime(items: ExternalNoteItem[]): ExternalNoteItem[] {
  return [...items].sort((a, b) => b.mtime - a.mtime);
}

export const useExternalImportsStore = create<ExternalImportsState>(
  (set, get) => ({
    pending: [],
    canvasId: null,

    connect: (canvasId) => {
      if (get().canvasId === canvasId && abortController) return;
      abortController?.abort();
      abortController = new AbortController();
      const signal = abortController.signal;
      set({ canvasId, pending: [] });

      void (async () => {
        try {
          const response = await fetch(externalStreamUrl(canvasId), { signal });
          if (!response.ok) return;
          await readTypedSSEStream<ExternalNoteEvent>(
            response,
            (event) => {
              if (get().canvasId !== canvasId) return;
              if (event.type === 'snapshot') {
                set({ pending: sortByMtime(event.data.items) });
              } else if (event.type === 'added') {
                const next = get().pending.filter(
                  (i) => i.relativePath !== event.data.relativePath,
                );
                next.push(event.data);
                set({ pending: sortByMtime(next) });
              } else if (event.type === 'removed') {
                set({
                  pending: get().pending.filter(
                    (i) => i.relativePath !== event.data.relativePath,
                  ),
                });
              }
            },
            signal,
          );
        } catch {
          /* aborted or network error — ignore */
        }
      })();
    },

    disconnect: () => {
      abortController?.abort();
      abortController = null;
      set({ pending: [], canvasId: null });
    },

    importItem: async (item) => {
      const canvasId = get().canvasId;
      if (!canvasId) return;
      // Optimistic removal; SSE will reconcile if the call fails.
      set({
        pending: get().pending.filter(
          (i) => i.relativePath !== item.relativePath,
        ),
      });
      try {
        const { label, content } = await importExternalNote(canvasId, {
          relativePath: item.relativePath,
        });
        useCanvasStore.getState().addNodes([
          {
            nodeType: 'note',
            data: {
              content,
              label,
              origin: { type: 'user-uploaded' },
            },
          },
        ]);
      } catch (error) {
        console.error('Failed to import external note', error);
      }
    },
  }),
);
