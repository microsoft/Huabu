// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createJSONStorage, persist } from 'zustand/middleware';

import { toast } from '@/components/Common/Toast';

import {
  applicationPreferenceStorage,
  readApplicationPreference,
  writeApplicationPreference,
} from './desktopStorage';

import type { DesktopPreferenceKey } from '@huabu/shared/desktop-tabs';
import type { StateCreator, StoreApi } from 'zustand';

interface PreferenceOptions<T, P> {
  name: DesktopPreferenceKey;
  version: number;
  partialize: (state: T) => P;
  migrate: (state: unknown, version: number) => P;
  merge: (persisted: unknown, current: T) => T;
}

export function persistApplicationPreferences<T, P>(
  initializer: StateCreator<T>,
  options: PreferenceOptions<T, P>,
): StateCreator<T, [], [['zustand/persist', P]]> {
  return (set, get, api) =>
    persist<T, [], [], P>(
      (persistedSet, get, api) => {
        // Desktop must persist before notifying Store subscribers.
        const commit: StoreApi<T>['setState'] = (partial, replace) => {
          if (!window.electronBridge?.tabs) {
            if (replace) persistedSet(partial as T, true);
            else persistedSet(partial);
            return;
          }
          try {
            const raw = readApplicationPreference(options.name);
            const stored: { state: unknown; version?: number } | null =
              raw === null ? null : JSON.parse(raw);
            const persisted =
              stored && stored.version !== options.version
                ? options.migrate(stored.state, stored.version ?? 0)
                : stored?.state;
            const current = options.merge(persisted, get());
            const patch =
              typeof partial === 'function'
                ? (partial as (state: T) => T | Partial<T>)(current)
                : partial;
            const next = (replace ? patch : { ...current, ...patch }) as T;
            const preferences = options.partialize(next);
            if (
              JSON.stringify(preferences) !==
              JSON.stringify(options.partialize(current))
            ) {
              writeApplicationPreference(
                options.name,
                JSON.stringify({
                  state: preferences,
                  version: options.version,
                }),
                raw,
              );
            }
            set(next, true);
          } catch (error) {
            console.error('[preferences] Could not update preference:', error);
            toast(error instanceof Error ? error.message : String(error), {
              tone: 'danger',
            });
            throw error;
          }
        };
        api.setState = commit;
        return initializer(commit, get, api);
      },
      {
        ...options,
        storage: createJSONStorage(applicationPreferenceStorage),
        onRehydrateStorage: () => (_state, error) => {
          if (!error) return;
          console.error('[preferences] Could not hydrate preference:', error);
          toast(error instanceof Error ? error.message : String(error), {
            tone: 'danger',
          });
        },
      },
    )(set, get, api);
}
