// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { desktopSpaceStorage } from '@/utils/desktopStorage';

/**
 * Which Agent changes this person has seen: per conversation, the `seenKey`s
 * of its records.
 *
 * Kept on this device: seeing is personal, and the record of it is small.
 * It is the only place that knows where "seen" is stored, so moving it to
 * the server changes this file alone.
 */
interface SeenChangesState {
  seen: Record<string, string[]>;
  markSeen: (threadId: string, keys: readonly string[]) => void;
  /** Forget a thread's keys whose records are gone (kept or reverted). */
  retain: (threadId: string, live: readonly string[]) => void;
}

export const useSeenChangesStore = create<SeenChangesState>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (threadId, keys) =>
        set((state) => {
          const current = state.seen[threadId] ?? [];
          const fresh = keys.filter((key) => !current.includes(key));
          if (fresh.length === 0) return state;
          return {
            seen: { ...state.seen, [threadId]: [...current, ...fresh] },
          };
        }),
      retain: (threadId, live) =>
        set((state) => {
          const current = state.seen[threadId];
          if (!current) return state;
          const kept = current.filter((key) => live.includes(key));
          if (kept.length === current.length) return state;
          const { [threadId]: _dropped, ...rest } = state.seen;
          return {
            seen: kept.length > 0 ? { ...rest, [threadId]: kept } : rest,
          };
        }),
    }),
    {
      name: 'huabu.seenAgentChanges',
      storage: createJSONStorage(() => desktopSpaceStorage()),
      partialize: (state) => ({ seen: state.seen }),
    },
  ),
);
