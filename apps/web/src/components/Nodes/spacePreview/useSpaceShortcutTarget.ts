// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '@/store/workspaceStore';

export interface SpaceShortcutTarget {
  title: string;
  nodeCount?: number;
  updatedAt?: number;
  status: 'loading' | 'ready' | 'missing' | 'error';
  /** Refresh errors may coexist with a last-confirmed ready target. */
  error: string | null;
  retry: () => void;
}

export function useSpaceShortcutTarget(
  targetCanvasId: string,
): SpaceShortcutTarget {
  const { t } = useTranslation();
  const title = useWorkspaceStore((state) =>
    Object.hasOwn(state.spaceTitles, targetCanvasId)
      ? state.spaceTitles[targetCanvasId]
      : null,
  );
  const exists = useWorkspaceStore((state) =>
    Object.hasOwn(state.spaceTitles, targetCanvasId),
  );
  const summary = useWorkspaceStore((state) =>
    Object.hasOwn(state.spaceSummaries, targetCanvasId)
      ? state.spaceSummaries[targetCanvasId]
      : undefined,
  );
  const metadataStatus = useWorkspaceStore((state) => state.spaceTitlesStatus);
  const error = useWorkspaceStore((state) => state.spaceTitlesError);
  const available = useWorkspaceStore(
    (state) => state.isReady && !state.isSyncing,
  );
  const refresh = useWorkspaceStore((state) => state.refreshSpaceTitles);

  useEffect(() => {
    if (available && metadataStatus === 'idle') void refresh();
  }, [available, metadataStatus, refresh]);

  const retry = useCallback(() => {
    void refresh();
  }, [refresh]);

  return {
    title: title?.trim() || t('spacePreview.untitledSpace'),
    nodeCount: available && exists ? summary?.nodeCount : undefined,
    updatedAt: available && exists ? summary?.updatedAt : undefined,
    status: !available
      ? 'loading'
      : exists
        ? 'ready'
        : metadataStatus === 'idle' || metadataStatus === 'loading'
          ? 'loading'
          : metadataStatus === 'error'
            ? 'error'
            : 'missing',
    error,
    retry,
  };
}
