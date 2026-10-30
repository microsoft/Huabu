// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';

import { getRecentCanvasConversation } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import { conversationViewForNode } from '@/store/conversationOwner';

import type { RecentCanvasConversationResponse } from '@huabu/shared';

type Destination = NonNullable<
  RecentCanvasConversationResponse['conversation']
>;

/** Existing owners only; staging never creates, realizes or starts an Agent. */
export function useCommentDestination(canvasId: string) {
  const nodes = useCanvasStore((state) => state.nodes);
  const pendingForks = useCanvasStore((state) => state.pendingForkThreadIds);
  const candidates = nodes.flatMap((node) => {
    const view = conversationViewForNode(node, canvasId);
    if (!view?.conversationOwner.threadId) return [];
    return [
      {
        nodeId: node.id,
        threadId: view.conversationOwner.threadId,
        title: typeof node.data.label === 'string' ? node.data.label : '',
        available: !pendingForks[view.conversationOwner.threadId],
      },
    ];
  });
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const explicitChoice = useRef(false);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    explicitChoice.current = false;
    setDestination(null);
    setLoading(true);
    setError(null);
    void getRecentCanvasConversation(canvasId, controller.signal).then(
      ({ conversation }) => {
        if (controller.signal.aborted || explicitChoice.current) return;
        const available = candidatesRef.current.filter(
          (item) => item.available,
        );
        const single = available.length === 1 ? available[0] : null;
        setDestination(
          conversation ??
            (single
              ? { nodeId: single.nodeId, threadId: single.threadId }
              : null),
        );
        setLoading(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted || explicitChoice.current) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [canvasId, retry]);

  const selected = candidates.find(
    (item) =>
      item.nodeId === destination?.nodeId &&
      item.threadId === destination.threadId,
  );
  return {
    candidates,
    destination,
    available: selected?.available === true,
    loading,
    error,
    choose: (choice: Destination) => {
      explicitChoice.current = true;
      setDestination(choice);
      setLoading(false);
      setError(null);
    },
    retry: () => setRetry((value) => value + 1),
  };
}
