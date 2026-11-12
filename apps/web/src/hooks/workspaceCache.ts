// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { useWorkspaceStore } from '@/store/workspaceStore';

export function createWorkspaceCache<T>() {
  const useCache = create(() => new Map<string, T>());
  useWorkspaceStore.subscribe((next, previous) => {
    if (
      next.workspaceId !== previous.workspaceId ||
      next.workspacePath !== previous.workspacePath
    ) {
      // Replacing the map also fences requests from an earlier activation.
      useCache.setState(new Map<string, T>(), true);
    }
  });
  return useCache;
}
