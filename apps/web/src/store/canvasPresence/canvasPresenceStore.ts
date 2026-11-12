// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { CANVAS_PAGE_ID } from '@/store/canvasStore/sync/pageId';
import { subscribeCanvasPresence } from '@/store/canvasSyncSubscription';

import type {
  CanvasPresenceEventData,
  CanvasPresencePage,
  CanvasPresencePoint,
} from '@huabu/shared';

/** Another page's presence without its pointer, which changes far more often. */
export type RemotePresencePage = Omit<CanvasPresencePage, 'pointer'>;

/**
 * The other pages that have this Space open.
 *
 * Separate from `canvasStore` on purpose: presence is not part of the Space,
 * so nothing here can mark it dirty, enter undo or be saved, and a pointer
 * tick re-renders only what subscribes to `pointers`. `pages` keeps its
 * identity across pointer ticks so node outlines do not re-render for them.
 */
interface CanvasPresenceState {
  canvasId: string | null;
  pages: Record<string, RemotePresencePage>;
  pointers: Record<string, CanvasPresencePoint>;
  /**
   * Follow the presence of `canvasId`. `onConnected` runs each time the
   * stream (re)connects, when this page must announce itself again.
   */
  connect: (canvasId: string, onConnected?: () => void) => void;
  disconnect: () => void;
  applyEvent: (event: CanvasPresenceEventData) => void;
  clear: () => void;
}

let unsubscribe: (() => void) | null = null;

function split(page: CanvasPresencePage): RemotePresencePage {
  const { pointer: _pointer, ...rest } = page;
  return rest;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function samePage(a: RemotePresencePage, b: RemotePresencePage): boolean {
  return (
    a.colorIndex === b.colorIndex &&
    a.label === b.label &&
    a.displayName === b.displayName &&
    sameIds(a.selectedNodeIds, b.selectedNodeIds) &&
    sameIds(a.draggingNodeIds, b.draggingNodeIds) &&
    sameIds(a.editingNodeIds, b.editingNodeIds)
  );
}

function withPointer(
  pointers: Record<string, CanvasPresencePoint>,
  pageId: string,
  pointer: CanvasPresencePoint | null,
): Record<string, CanvasPresencePoint> {
  const current = pointers[pageId];
  if (!pointer) {
    if (!current) return pointers;
    const { [pageId]: _removed, ...rest } = pointers;
    return rest;
  }
  if (current?.x === pointer.x && current.y === pointer.y) return pointers;
  return { ...pointers, [pageId]: pointer };
}

export const useCanvasPresenceStore = create<CanvasPresenceState>(
  (set, get) => ({
    canvasId: null,
    pages: {},
    pointers: {},

    connect: (canvasId, onConnected) => {
      if (get().canvasId === canvasId && unsubscribe) return;
      unsubscribe?.();
      set({ canvasId, pages: {}, pointers: {} });
      unsubscribe = subscribeCanvasPresence(canvasId, {
        onEvent: (event) => {
          if (get().canvasId !== canvasId) return;
          get().applyEvent(event);
          if (event.op === 'snapshot') onConnected?.();
        },
        onDisconnect: () => {
          if (get().canvasId === canvasId) get().clear();
        },
      });
    },

    disconnect: () => {
      unsubscribe?.();
      unsubscribe = null;
      set({ canvasId: null, pages: {}, pointers: {} });
    },

    clear: () => {
      const state = get();
      if (
        Object.keys(state.pages).length === 0 &&
        Object.keys(state.pointers).length === 0
      )
        return;
      set({ pages: {}, pointers: {} });
    },

    applyEvent: (event) => {
      // The server already leaves this page out; never render our own marker
      // even if a stream was opened without the page id.
      if (event.op === 'snapshot') {
        const pages: Record<string, RemotePresencePage> = {};
        const pointers: Record<string, CanvasPresencePoint> = {};
        for (const page of event.pages) {
          if (page.pageId === CANVAS_PAGE_ID) continue;
          pages[page.pageId] = split(page);
          if (page.pointer) pointers[page.pageId] = page.pointer;
        }
        set({ pages, pointers });
        return;
      }
      const pageId = event.op === 'update' ? event.page.pageId : event.pageId;
      if (pageId === CANVAS_PAGE_ID) return;
      const state = get();
      if (event.op === 'leave') {
        if (!state.pages[pageId] && !state.pointers[pageId]) return;
        const { [pageId]: _page, ...pages } = state.pages;
        set({ pages, pointers: withPointer(state.pointers, pageId, null) });
        return;
      }
      if (event.op === 'pointer') {
        // A pointer for a page we have not been told about is not drawn:
        // without its `update` there is no colour or label for it.
        if (!state.pages[pageId]) return;
        const pointers = withPointer(state.pointers, pageId, event.pointer);
        if (pointers !== state.pointers) set({ pointers });
        return;
      }
      const next = split(event.page);
      const current = state.pages[pageId];
      const pages =
        current && samePage(current, next)
          ? state.pages
          : { ...state.pages, [pageId]: next };
      const pointers = withPointer(state.pointers, pageId, event.page.pointer);
      if (pages !== state.pages || pointers !== state.pointers)
        set({ pages, pointers });
    },
  }),
);
