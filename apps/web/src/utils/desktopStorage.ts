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

function isPreferenceKey(key: string): key is DesktopPreferenceKey {
  return preferenceKeys.includes(key);
}

function bootstrapDesktopStorage(): void {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (!tabs?.storageSnapshot || tabs.context.role === 'shell') return;
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
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (!preferenceKeys.includes(key) && localStorage.getItem(key) === null)
      localStorage.setItem(key, value);
  }
  for (const key of preferenceKeys) localStorage.removeItem(key);
}

bootstrapDesktopStorage();

export function readApplicationPreference(
  key: DesktopPreferenceKey,
): string | null {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (tabs) {
    const snapshot = tabs.storageSnapshot();
    if (!snapshot.ok) {
      console.error(
        '[desktop-tabs] Could not read preference:',
        snapshot.error,
      );
      throw new Error(snapshot.error);
    }
    return snapshot.values[key] ?? null;
  }
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

export function subscribeApplicationPreferences(
  listener: (key: DesktopPreferenceKey) => void,
): () => void {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (tabs) return tabs.onPreference(({ key }) => listener(key));
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key && isPreferenceKey(event.key)) listener(event.key);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function writeApplicationPreference(
  key: DesktopPreferenceKey,
  value: string | null,
  expectedValue?: string | null,
): void {
  const tabs =
    typeof window === 'undefined' ? undefined : window.electronBridge?.tabs;
  if (tabs) {
    const result =
      expectedValue === undefined
        ? tabs.setPreference(key, value)
        : tabs.setPreference(key, value, expectedValue);
    if (!result.ok) {
      console.error('[desktop-tabs] Could not save preference:', result.error);
      throw new Error(result.error);
    }
    return;
  }
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export function applicationPreferenceStorage(): StateStorage {
  const preferenceKey = (key: string): DesktopPreferenceKey => {
    if (!isPreferenceKey(key))
      throw new Error(`Unknown application preference: ${key}`);
    return key;
  };
  return {
    getItem: (key) => readApplicationPreference(preferenceKey(key)),
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
