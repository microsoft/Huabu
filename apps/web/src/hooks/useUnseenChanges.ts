// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo } from 'react';

import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useSeenChangesStore } from '@/store/seenChangesStore';
import {
  threadSeenKeys,
  unseenMarks,
  type UnseenMark,
} from '@/utils/unseenChanges';

/**
 * The marks, each with the conversation that changed the node last put
 * first. Only a conversation that spoke while this page was open has a known
 * place in time; the others follow in the order they are held.
 */
function latestFirst(
  marks: Map<string, UnseenMark>,
  liveThreads: Readonly<Record<string, number>>,
): Map<string, UnseenMark> {
  for (const mark of marks.values())
    mark.sources.sort(
      (a, b) => (liveThreads[b.threadId] ?? 0) - (liveThreads[a.threadId] ?? 0),
    );
  return marks;
}

/** The unseen mark of each node of the Space on screen, by node id. */
export function useUnseenMarks(): Map<string, UnseenMark> {
  const byThread = useAcpThreadChangesStore((state) => state.byThread);
  const liveThreads = useAcpThreadChangesStore((state) => state.liveThreads);
  const seen = useSeenChangesStore((state) => state.seen);
  return useMemo(
    () => latestFirst(unseenMarks(byThread, seen), liveThreads),
    [byThread, seen, liveThreads],
  );
}

/** The unseen marks as they are now, for code outside render. */
export function readUnseenMarks(): Map<string, UnseenMark> {
  const { byThread, liveThreads } = useAcpThreadChangesStore.getState();
  return latestFirst(
    unseenMarks(byThread, useSeenChangesStore.getState().seen),
    liveThreads,
  );
}

/** Record a node's mark as seen, for every conversation it holds. */
export function markSeen(mark: UnseenMark): void {
  const store = useSeenChangesStore.getState();
  for (const source of mark.sources)
    store.markSeen(source.threadId, source.keys);
}

/** How often, at most, the tracker reads the stores it follows. */
const FOLLOW_MS = 150;
/** The first wait before asking again for records that could not be read. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * Keep the marks of a Space true: load what its conversations changed, and
 * record what the person has seen.
 *
 * - A node counts as seen once the person has been on it — it was the only
 *   node selected, which clicking, opening or editing it does — and moved
 *   on. Passing it on the canvas, reading the conversation, or carrying the
 *   conversation on into another turn is not seeing it.
 */
export function useTrackUnseenChanges(canvasId: string | undefined): void {
  useEffect(() => {
    if (!canvasId) return;
    let live = true;
    const asked = new Set<string>();
    /** Asked for, and not read: to be asked for again. */
    const unread = new Set<string>();
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const canvas = useCanvasStore.getState();
      if (canvas.canvasId !== canvasId || canvas.isLoading) return;
      const threadIds = canvas.nodes.flatMap((node) =>
        node.data.type === 'question' &&
        typeof node.data.threadId === 'string' &&
        !asked.has(node.data.threadId)
          ? [node.data.threadId]
          : [],
      );
      if (threadIds.length === 0) return;
      for (const threadId of threadIds) asked.add(threadId);
      void useAcpThreadChangesStore
        .getState()
        .loadSpace(canvasId, threadIds)
        .then((read) => {
          if (!live) return;
          if (read) {
            failures = 0;
            return;
          }
          // Not read, so not asked: a later look asks again. Wait longer
          // after each failure in a row, so a server that is down is not
          // asked on every change to the canvas.
          failures += 1;
          // Every load that failed while the wait runs is asked again at
          // its end, not only the one that started it.
          for (const threadId of threadIds) unread.add(threadId);
          retry ??= setTimeout(
            () => {
              retry = undefined;
              for (const threadId of unread) asked.delete(threadId);
              unread.clear();
              load();
            },
            Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS),
          );
        });
    };

    // The only node selected, and whether it carried a mark when the person
    // came to it or while they stayed.
    let selected: string | null = null;
    let marked = false;
    const see = () => {
      const canvas = useCanvasStore.getState();
      if (canvas.canvasId !== canvasId) return;
      let only: string | null = null;
      let count = 0;
      for (const node of canvas.nodes)
        if (node.selected) {
          count += 1;
          only = node.id;
        }
      if (count !== 1) only = null;
      if (only === selected) {
        // A mark can arrive while the person is already on the node.
        if (selected !== null && !marked)
          marked = readUnseenMarks().has(selected);
        return;
      }
      // Seen when the person moves on, not when they arrive: while they are
      // on the node its mark stays, and with it the way to the conversation.
      const left =
        selected !== null && marked
          ? readUnseenMarks().get(selected)
          : undefined;
      if (left) markSeen(left);
      selected = only;
      marked = only !== null && readUnseenMarks().has(only);
    };

    const forget = () => {
      const { byThread } = useAcpThreadChangesStore.getState();
      const { seen, retain } = useSeenChangesStore.getState();
      for (const threadId of Object.keys(seen))
        if (byThread[threadId])
          retain(threadId, threadSeenKeys(byThread[threadId]));
    };

    // The canvas store changes on every pointer tick of a drag; reading all
    // nodes that often would cost more than the marks are worth.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        load();
        see();
      }, FOLLOW_MS);
    };
    const unsubscribeCanvas = useCanvasStore.subscribe(follow);
    const unsubscribeChanges = useAcpThreadChangesStore.subscribe(() => {
      forget();
      follow();
    });
    load();
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(retry);
      unsubscribeCanvas();
      unsubscribeChanges();
    };
  }, [canvasId]);
}
