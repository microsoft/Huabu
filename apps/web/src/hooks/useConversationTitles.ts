// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef } from 'react';

import {
  needsConversationTitleRefresh,
  refreshConversationTitles,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';

import type { CanvasPreviewWorkspace } from '@/store/previewWorkspace/model';

/** One workspace subscription includes cold tabs; renderers never fetch titles. */
export function useConversationTitles(workspace: CanvasPreviewWorkspace) {
  const targets = JSON.stringify(
    Object.values(workspace.tabs)
      .flatMap(({ target }) =>
        target.kind === 'chat' ? [[target.canvasId, target.threadId]] : [],
      )
      .sort(),
  );
  const epoch = useConversationTitleStore((state) => state.refreshEpoch);
  const hydration = useRef<Promise<void>>(Promise.resolve());
  const refresh = useCallback(
    async (unresolvedOnly: boolean) => {
      const addresses = JSON.parse(targets) as [string, string][];
      const batches = new Map<string, string[]>();
      for (const [canvasId, threadId] of addresses) {
        if (
          unresolvedOnly &&
          !needsConversationTitleRefresh(canvasId, threadId)
        )
          continue;
        const ids = batches.get(canvasId) ?? [];
        ids.push(threadId);
        batches.set(canvasId, ids);
      }
      await Promise.all(
        [...batches].map(([canvasId, ids]) =>
          refreshConversationTitles(canvasId, ids),
        ),
      );
    },
    [targets],
  );

  useEffect(() => {
    hydration.current = refresh(false);
    const onFocus = () => {
      void refresh(false);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Generation can outlive the answer stream. Retry only unresolved titles,
    // for a finite window; target changes and later turns start a fresh window.
    // Stream refresh already queries its thread; an epoch only restarts delays.
    const delays = [1000, 3000, 10000, 30000, 60000];
    const run = async (attempt: number) => {
      if (attempt === 0) await hydration.current;
      else await refresh(true);
      if (!cancelled && attempt < delays.length)
        timer = setTimeout(() => {
          void run(attempt + 1);
        }, delays[attempt]);
    };
    void run(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh, epoch]);
}
