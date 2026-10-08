// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getRecentCanvasConversation } from '@/api/canvas';

import type { AgentChoice } from '@/components/Panels/ChatPanel/agentMenu';

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
  error: Error | null;
}

const UNRESOLVED: InkDestination = { kind: 'unresolved' };

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
  const candidatesRef = useRef(conversations);
  candidatesRef.current = conversations;
  const updateDraft = useCallback((next: DestinationDraft | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

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
      !previous.loading
    )
      return;
    const controller = new AbortController();
    const scope = { canvasId, selectionSession, retry };
    updateDraft({
      ...scope,
      destination: UNRESOLVED,
      loading: true,
      error: null,
    });
    void getRecentCanvasConversation(canvasId, controller.signal).then(
      ({ conversation }) => {
        if (request !== generation.current || controller.signal.aborted) return;
        const candidates = candidatesRef.current;
        const available = candidates.filter(
          (candidate) => candidate.available && candidate.threadId,
        );
        const single = available.length === 1 ? available[0] : undefined;
        const destination: InkDestination = conversation
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
        updateDraft({ ...scope, destination, loading: false, error: null });
      },
      (error: unknown) => {
        if (request !== generation.current || controller.signal.aborted) return;
        updateDraft({
          ...scope,
          destination: UNRESOLVED,
          loading: false,
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
    error: current?.error ?? null,
    choose,
    retryDefault,
  };
}
