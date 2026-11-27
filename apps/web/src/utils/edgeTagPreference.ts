// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useSyncExternalStore } from 'react';

import {
  readApplicationPreference,
  subscribeApplicationPreferences,
  writeApplicationPreference,
} from './desktopStorage';

const KEY = 'huabu.showEdgeTags';

/** This page's own listeners: a write here is not announced to its writer. */
const listeners = new Set<() => void>();

/** The tags are shown until the person turns them off. */
export function readEdgeTagsEnabled(): boolean {
  try {
    return readApplicationPreference(KEY) !== 'false';
  } catch {
    // Storage that cannot be read holds no "off".
    return true;
  }
}

/** Absent means on, so only "off" is stored. */
export function writeEdgeTagsEnabled(on: boolean): void {
  writeApplicationPreference(KEY, on ? null : 'false');
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeApplicationPreferences((key) => {
    if (key === KEY) listener();
  });
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

/** Whether the canvas points at what is unseen and out of view. */
export function useEdgeTagsEnabled(): boolean {
  return useSyncExternalStore(subscribe, readEdgeTagsEnabled);
}
