// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { DesktopPreferenceKey } from '@huabu/shared/desktop-tabs';
import type { StateStorage } from 'zustand/middleware';

const preferenceKeys = [
  'huabu.language',
  'huabu-sketch-tools',
  'huabu-chat-preferences',
  'huabu:world-enabled',
  'huabu.minimapEnabled',
];

function bootstrapDesktopStorage(): void {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (!tabs?.storageSnapshot) return;
  const legacy =
    tabs.context.role === 'home'
      ? Object.fromEntries(
          Object.keys(localStorage)
            .filter(
              (key) =>
                preferenceKeys.includes(key) ||
                [
                  'huabu-chat',
                  'huabu-panel',
                  'huabu-conversation-preparation',
                  'huabu.conversationTitleDrafts',
                ].includes(key) ||
                (!key.includes('.desktop.') &&
                  (key.startsWith('huabu.viewport.') ||
                    key.startsWith('huabu.previewWorkspace.'))),
            )
            .flatMap((key) => {
              const value = localStorage.getItem(key);
              return value === null ? [] : [[key, value] as const];
            }),
        )
      : undefined;
  const snapshot = tabs.storageSnapshot(legacy);
  if (!snapshot.ok) {
    console.error(
      '[desktop-tabs] Could not initialize storage:',
      snapshot.error,
    );
    throw new Error(snapshot.error);
  }
  for (const key of preferenceKeys) {
    if (snapshot.values[key] === undefined) localStorage.removeItem(key);
  }
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (preferenceKeys.includes(key) || localStorage.getItem(key) === null)
      localStorage.setItem(key, value);
  }
  tabs.onPreference(({ key }) => {
    const current = tabs.storageSnapshot();
    if (!current.ok) {
      console.error(
        '[desktop-tabs] Could not refresh preference:',
        current.error,
      );
      throw new Error(current.error);
    }
    const value = current.values[key] ?? null;
    const oldValue = localStorage.getItem(key);
    if (value === oldValue) return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        oldValue,
        newValue: value,
        storageArea: localStorage,
      }),
    );
  });
}

bootstrapDesktopStorage();

export function writeApplicationPreference(
  key: DesktopPreferenceKey,
  value: string | null,
): void {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (tabs?.setPreference && tabs.context.role !== 'shell') {
    const result = tabs.setPreference(key, value);
    if (!result.ok) {
      console.error('[desktop-tabs] Could not save preference:', result.error);
      throw new Error(result.error);
    }
  }
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export function applicationPreferenceStorage(): StateStorage {
  const preferenceKey = (key: string): DesktopPreferenceKey => {
    if (!preferenceKeys.includes(key))
      throw new Error(`Unknown application preference: ${key}`);
    return key as DesktopPreferenceKey;
  };
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) =>
      writeApplicationPreference(preferenceKey(key), value),
    removeItem: (key) => writeApplicationPreference(preferenceKey(key), null),
  };
}

export function desktopStorageKey(key: string): string {
  const context =
    typeof window === 'undefined'
      ? undefined
      : window.electronBridge?.tabs?.context;
  return context?.role === 'space' && context.workspaceId && context.canvasId
    ? `${key}.desktop.${JSON.stringify([context.workspaceId, context.canvasId])}`
    : key;
}

/** Copy legacy state on first read; never let a content page overwrite the shared record. */
export function desktopSpaceStorage(): StateStorage {
  return {
    getItem: (key) => {
      const scoped = desktopStorageKey(key);
      const current = localStorage.getItem(scoped);
      if (current !== null || scoped === key) return current;
      const legacy = localStorage.getItem(key);
      if (legacy !== null) localStorage.setItem(scoped, legacy);
      return legacy;
    },
    setItem: (key, value) =>
      localStorage.setItem(desktopStorageKey(key), value),
    removeItem: (key) => localStorage.removeItem(desktopStorageKey(key)),
  };
}
