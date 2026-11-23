// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useMemo } from 'react';

import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
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

/** Mark everything a conversation's Agent changed as seen. */
function markThreadSeen(threadId: string): void {
  useSeenChangesStore
    .getState()
    .markSeen(
      threadId,
      threadSeenKeys(useAcpThreadChangesStore.getState().byThread[threadId]),
    );
}

/** How often, at most, the tracker reads the stores it follows. */
const FOLLOW_MS = 150;

/**
 * Keep the marks of a Space true: load what its conversations changed, and
 * record what the person has seen.
 *
 * - A node counts as seen once the person has been on it — it was the only
 *   node selected, which clicking, opening or editing it does — and moved
 *   on. Passing it on the canvas, or reading the conversation, is not
 *   seeing it.
 * - A conversation's marks end when its next turn begins.
 */
export function useTrackUnseenChanges(canvasId: string | undefined): void {
  useEffect(() => {
    if (!canvasId) return;
    const asked = new Set<string>();
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
      void useAcpThreadChangesStore.getState().loadSpace(canvasId, threadIds);
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

    // The conversations streaming now. One that is already streaming when
    // the page opens is mid-turn: what it has made so far is this turn's.
    const streamingNow = () =>
      new Set(
        Object.entries(useChatStore.getState().threadsById).flatMap(
          ([threadId, thread]) => (thread.isStreaming ? [threadId] : []),
        ),
      );
    let streaming = streamingNow();
    const turns = () => {
      const next = streamingNow();
      for (const threadId of next)
        if (!streaming.has(threadId)) markThreadSeen(threadId);
      streaming = next;
    };

    const forget = () => {
      const { byThread } = useAcpThreadChangesStore.getState();
      const { seen, retain } = useSeenChangesStore.getState();
      for (const threadId of Object.keys(seen))
        if (byThread[threadId])
          retain(threadId, threadSeenKeys(byThread[threadId]));
    };

    // These stores change on every pointer tick of a drag and every token of
    // a reply; reading them that often would cost more than the marks are
    // worth. A turn's start is noticed within the same delay, before its
    // first change arrives.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        turns();
        load();
        see();
      }, FOLLOW_MS);
    };
    const unsubscribeCanvas = useCanvasStore.subscribe(follow);
    const unsubscribeChat = useChatStore.subscribe(follow);
    const unsubscribeChanges = useAcpThreadChangesStore.subscribe(() => {
      forget();
      follow();
    });
    load();
    return () => {
      clearTimeout(timer);
      unsubscribeCanvas();
      unsubscribeChat();
      unsubscribeChanges();
    };
  }, [canvasId]);
}
