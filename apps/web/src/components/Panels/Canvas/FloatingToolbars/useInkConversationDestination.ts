// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getRecentCanvasConversation } from '@/api/canvas';

import type { AgentChoice } from '@/components/Panels/ChatPanel/agentMenu';
import type { RecentCanvasConversationResponse } from '@huabu/shared';

export type InkDestination =
  | { kind: 'unresolved' }
  | { kind: 'new'; choice?: AgentChoice }
  | { kind: 'continue'; nodeId: string; threadId: string };

interface ConversationCandidate {
  nodeId: string;
  threadId?: string;
  available: boolean;
}

interface DestinationDraft {
  canvasId: string;
  selectionSession: object | null;
  retry: number;
  destination: InkDestination;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
}

const UNRESOLVED: InkDestination = { kind: 'unresolved' };

function resolveDefaultDestination(
  conversation: RecentCanvasConversationResponse['conversation'],
  candidates: readonly ConversationCandidate[],
): InkDestination {
  const available = candidates.filter(
    (candidate) => candidate.available && candidate.threadId,
  );
  const single = available.length === 1 ? available[0] : undefined;
  return conversation
    ? { kind: 'continue', ...conversation }
    : single?.threadId
      ? {
          kind: 'continue',
          nodeId: single.nodeId,
          threadId: single.threadId,
        }
      : candidates.length === 0
        ? { kind: 'new' }
        : UNRESOLVED;
}

export function useInkConversationDestination({
  canvasId,
  hasSelection,
  selecting,
  selectionSession,
  conversations,
}: {
  canvasId: string;
  hasSelection: boolean;
  selecting: boolean;
  selectionSession: object | null;
  conversations: readonly ConversationCandidate[];
}) {
  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const draftRef = useRef<DestinationDraft | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const prefetchedRecentRef = useRef<{
    canvasId: string;
    conversation: RecentCanvasConversationResponse['conversation'];
  } | null>(null);
  const candidatesRef = useRef(conversations);
  candidatesRef.current = conversations;
  const updateDraft = useCallback((next: DestinationDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  useEffect(() => {
    if (hasSelection || selecting) return;
    if (prefetchedRecentRef.current?.canvasId === canvasId) return;
    const controller = new AbortController();
    void getRecentCanvasConversation(canvasId, controller.signal).then(
      ({ conversation }) => {
        if (controller.signal.aborted) return;
        prefetchedRecentRef.current = { canvasId, conversation };
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn(
          'Failed to prefetch the recent Canvas conversation',
          error,
        );
      },
    );
    return () => controller.abort();
  }, [canvasId, hasSelection, selecting]);

  useEffect(() => {
    const request = ++generation.current;
    // A preview can be cancelled; only commit or dismissal replaces its draft.
    if (selecting) return;
    if (!hasSelection) {
      updateDraft(null);
      return;
    }
    const previous = draftRef.current;
    if (
      previous?.canvasId === canvasId &&
      previous.selectionSession === selectionSession &&
      previous.retry === retry &&
      !previous.refreshing
    )
      return;
    const controller = new AbortController();
    const scope = { canvasId, selectionSession, retry };
    const prefetched =
      prefetchedRecentRef.current?.canvasId === canvasId
        ? prefetchedRecentRef.current
        : null;
    const localDestination = resolveDefaultDestination(
      null,
      candidatesRef.current,
    );
    const destination = prefetched
      ? resolveDefaultDestination(
          prefetched.conversation,
          candidatesRef.current,
        )
      : localDestination;
    updateDraft({
      ...scope,
      destination,
      loading: !prefetched && destination.kind === 'unresolved',
      refreshing: true,
      error: null,
    });
    void getRecentCanvasConversation(canvasId, controller.signal).then(
      ({ conversation }) => {
        if (request !== generation.current || controller.signal.aborted) return;
        const candidates = candidatesRef.current;
        prefetchedRecentRef.current = { canvasId, conversation };
        const destination = resolveDefaultDestination(conversation, candidates);
        updateDraft({
          ...scope,
          destination,
          loading: false,
          refreshing: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (request !== generation.current || controller.signal.aborted) return;
        updateDraft({
          ...scope,
          destination: UNRESOLVED,
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [hasSelection, selecting, selectionSession, canvasId, retry, updateDraft]);

  const choose = useCallback(
    (destination: InkDestination) => {
      // A late default response must never replace an explicit choice.
      generation.current++;
      updateDraft({
        canvasId,
        selectionSession,
        retry,
        destination,
        loading: false,
        refreshing: false,
        error: null,
      });
    },
    [canvasId, selectionSession, retry, updateDraft],
  );
  const retryDefault = useCallback(() => setRetry((value) => value + 1), []);
  const active = hasSelection && !selecting;
  const current =
    active &&
    draft?.canvasId === canvasId &&
    draft.selectionSession === selectionSession &&
    draft.retry === retry
      ? draft
      : null;
  return {
    destination: current?.destination ?? UNRESOLVED,
    loading: active && (current?.loading ?? true),
    confirming: active && (current?.refreshing ?? true),
    error: current?.error ?? null,
    choose,
    retryDefault,
  };
}
