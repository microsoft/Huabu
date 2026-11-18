// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';

import { getRecentCanvasConversation } from '@/api/canvas';
import useCanvasStore from '@/store/canvasStore';
import {
  commentDestinationKey,
  isCommentScopeCurrent,
  rememberCommentDestination,
  useCommentDestinationMemory,
} from '@/store/commentDestinationMemory';
import { conversationViewForNode } from '@/store/conversationOwner';

import type { CommentDestination } from '@/store/commentDestinationMemory';

type Candidate = CommentDestination & { title: string; available: boolean };

export function commentDestinationTitle(
  item: Candidate,
  candidates: readonly Candidate[],
  untitled: string,
) {
  const title = item.title || untitled;
  return candidates.some(
    (other) => other.nodeId !== item.nodeId && other.title === item.title,
  )
    ? `${title} · ${item.nodeId}`
    : title;
}

export function resolveCommentDestination(
  canvasId: string,
  destination: CommentDestination | null,
) {
  const canvas = useCanvasStore.getState();
  const node = canvas.nodes.find((item) => item.id === destination?.nodeId);
  const view = node ? conversationViewForNode(node, canvasId) : null;
  return canvas.canvasId === canvasId &&
    !canvas.isLoading &&
    view &&
    view.conversationOwner.threadId === destination?.threadId &&
    !canvas.pendingForkThreadIds[view.conversationOwner.threadId]
    ? view
    : null;
}

function createSession(canvasId: string) {
  const memory = useCommentDestinationMemory.getState();
  const remembered = memory.lastComment;
  const destination =
    remembered?.kind === 'agent'
      ? remembered.destination
      : remembered
        ? null
        : memory.lastPreview;
  return {
    canvasId,
    scope: memory.scope,
    destination,
    temporary: remembered?.kind === 'temporary',
    resolved: !!remembered || !!destination,
    previewOrder: memory.previewOrder,
    activity: new Map(
      useCanvasStore.getState().nodes.map((node) => [
        commentDestinationKey({
          nodeId: node.id,
          threadId: String(node.data.threadId ?? ''),
        }),
        typeof node.data.lastActivityAt === 'number'
          ? node.data.lastActivityAt
          : 0,
      ]),
    ),
    recent: null as CommentDestination | null,
    error: null as Error | null,
  };
}

/** Existing owners only; staging never creates, realizes or starts an Agent. */
export function useCommentDestination(canvasId: string) {
  const nodes = useCanvasStore((state) => state.nodes);
  const pendingForks = useCanvasStore((state) => state.pendingForkThreadIds);
  const activeCanvasId = useCanvasStore((state) => state.canvasId);
  const isLoading = useCanvasStore((state) => state.isLoading);
  const scope = useCommentDestinationMemory((state) => state.scope);
  const [session, setSession] = useState(() => createSession(canvasId));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [retry, setRetry] = useState(0);
  if (session.canvasId !== canvasId) {
    setSession(createSession(canvasId));
  }
  const current =
    session.canvasId === canvasId &&
    session.scope === scope &&
    activeCanvasId === canvasId &&
    !isLoading &&
    isCommentScopeCurrent(canvasId, session.scope);
  const candidates: Candidate[] = (
    activeCanvasId === canvasId ? nodes : []
  ).flatMap((node) => {
    const view = conversationViewForNode(node, canvasId);
    if (!view?.conversationOwner.threadId) return [];
    return [
      {
        nodeId: node.id,
        threadId: view.conversationOwner.threadId,
        title: typeof node.data.label === 'string' ? node.data.label : '',
        available: current && !pendingForks[view.conversationOwner.threadId],
      },
    ];
  });
  const pinned =
    session.destination && commentDestinationKey(session.destination);
  const recent = session.recent && commentDestinationKey(session.recent);
  candidates.sort((a, b) => {
    const left = commentDestinationKey(a);
    const right = commentDestinationKey(b);
    return (
      Number(right === pinned) - Number(left === pinned) ||
      (session.previewOrder.get(right) ?? 0) -
        (session.previewOrder.get(left) ?? 0) ||
      Number(right === recent) - Number(left === recent) ||
      (session.activity.get(right) ?? 0) - (session.activity.get(left) ?? 0) ||
      (left < right ? -1 : left > right ? 1 : 0)
    );
  });
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  useEffect(() => {
    const initial = sessionRef.current;
    if (
      initial.canvasId !== canvasId ||
      initial.resolved ||
      initial.error ||
      !isCommentScopeCurrent(canvasId, initial.scope)
    )
      return;
    const controller = new AbortController();
    void getRecentCanvasConversation(canvasId, controller.signal).then(
      ({ conversation }) => {
        if (
          controller.signal.aborted ||
          sessionRef.current !== initial ||
          !isCommentScopeCurrent(canvasId, initial.scope)
        )
          return;
        const available = candidatesRef.current.filter(
          (item) => item.available,
        );
        const single = available.length === 1 ? available[0] : null;
        const next = {
          ...initial,
          destination:
            conversation ??
            (single
              ? {
                  nodeId: single.nodeId,
                  threadId: single.threadId,
                }
              : null),
          recent: conversation,
          resolved: true,
          error: null,
        };
        sessionRef.current = next;
        setSession(next);
      },
      (reason: unknown) => {
        if (
          controller.signal.aborted ||
          sessionRef.current !== initial ||
          !isCommentScopeCurrent(canvasId, initial.scope)
        )
          return;
        const next = {
          ...initial,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        };
        sessionRef.current = next;
        setSession(next);
      },
    );
    return () => controller.abort();
  }, [canvasId, retry, scope, current]);

  const selected = candidates.find(
    (item) =>
      item.nodeId === session.destination?.nodeId &&
      item.threadId === session.destination.threadId,
  );
  return {
    candidates,
    destination: session.destination,
    available: current && selected?.available === true,
    scopeValid: current,
    temporary: session.temporary,
    loading: current && !session.resolved && !session.error,
    error: session.error,
    isCurrent: () => isCommentScopeCurrent(canvasId, session.scope),
    resolve: () =>
      isCommentScopeCurrent(canvasId, session.scope)
        ? resolveCommentDestination(canvasId, session.destination)
        : null,
    rememberStaged: (threadId: string) =>
      rememberCommentDestination(
        canvasId,
        session.scope,
        session.destination,
        threadId,
      ),
    choose: (choice: CommentDestination | null) => {
      if (!isCommentScopeCurrent(canvasId, session.scope)) return;
      const next = {
        ...session,
        destination: choice,
        resolved: true,
        temporary: false,
        error: null,
      };
      sessionRef.current = next;
      setSession(next);
    },
    retry: () => {
      if (session.resolved || !isCommentScopeCurrent(canvasId, session.scope))
        return;
      const next = { ...session, error: null };
      sessionRef.current = next;
      setSession(next);
      setRetry((value) => value + 1);
    },
  };
}
