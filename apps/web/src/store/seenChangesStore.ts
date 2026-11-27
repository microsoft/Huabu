// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { getSeenChanges, markSeenChanges } from '@/api/threadChanges';

import type { SeenChange, SeenChanges } from '@huabu/shared';

/**
 * What this person has seen of the changes Agents made in the Space on
 * screen: conversation → node → the state of the review they saw.
 *
 * The server keeps it, one record per person per Space, so a node seen on
 * one device is seen on the others. This store is the page's copy: what the
 * server last said, with the cells this page has marked and the server has
 * not yet confirmed laid over it, so a mark does not flicker back while its
 * write is on the way.
 */
interface SeenChangesState {
  /** What the server last said. */
  stored: SeenChanges;
  /** Cells marked here whose write has not been confirmed. */
  pending: SeenChange[];
  /** `stored` with `pending` laid over it: what the marks are judged by. */
  seen: SeenChanges;
  /** Take the cells of some conversations from a read of the server. */
  adopt: (seen: SeenChanges) => void;
  /** Read the whole record again; another device may have written it. */
  refresh: (canvasId: string) => Promise<void>;
  /** Mark cells seen, here at once and on the server. */
  markSeen: (canvasId: string, cells: readonly SeenChange[]) => void;
  /** Forget everything: the page shows another Space. */
  reset: () => void;
}

function overlay(stored: SeenChanges, pending: readonly SeenChange[]) {
  if (pending.length === 0) return stored;
  const seen: SeenChanges = { ...stored };
  for (const { threadId, nodeId, key } of pending)
    seen[threadId] = { ...seen[threadId], [nodeId]: key };
  return seen;
}

/** One write at a time; what is marked meanwhile goes with the next. */
let writing = false;

export const useSeenChangesStore = create<SeenChangesState>((set, get) => {
  const settle = (stored: SeenChanges, pending: SeenChange[]) =>
    set({ stored, pending, seen: overlay(stored, pending) });

  const flush = async (canvasId: string): Promise<void> => {
    if (writing) return;
    const sent = get().pending;
    if (sent.length === 0) return;
    writing = true;
    try {
      const stored = await markSeenChanges(canvasId, sent);
      // What was marked while this write was on its way is still pending.
      settle(
        stored,
        get().pending.filter((cell) => !sent.includes(cell)),
      );
    } catch (error) {
      // The cells stay pending: this page keeps showing them as seen, and
      // the next mark sends them again.
      console.error('[seenChanges] Could not record what was seen', error);
      return;
    } finally {
      writing = false;
    }
    await flush(canvasId);
  };

  return {
    stored: {},
    pending: [],
    seen: {},

    adopt: (seen) => settle({ ...get().stored, ...seen }, get().pending),

    refresh: async (canvasId) => {
      try {
        settle(await getSeenChanges(canvasId), get().pending);
      } catch (error) {
        console.error('[seenChanges] Could not read what was seen', error);
      }
    },

    markSeen: (canvasId, cells) => {
      const { seen, stored, pending } = get();
      const fresh = cells.filter(
        ({ threadId, nodeId, key }) => seen[threadId]?.[nodeId] !== key,
      );
      if (fresh.length === 0) return;
      settle(stored, [...pending, ...fresh]);
      void flush(canvasId);
    },

    reset: () => settle({}, []),
  };
});
