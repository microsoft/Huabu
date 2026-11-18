// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useState } from 'react';

import { agentApi } from '@/api/agent';
import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { useChatSession } from './useChatSession';

import type { AssistantToolPart } from '@huabu/shared';

const pending = new Map<string, Promise<void>>();

export function loadHistoryToolDetails(
  canvasId: string,
  threadId: string,
  turnRef: string,
): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  const key = JSON.stringify([workspaceId, canvasId, threadId, turnRef]);
  const existing = pending.get(key);
  if (existing) return existing;
  const state = useChatStore.getState();
  const revision = state.threadsById[threadId]?.historyRevision;
  const targets =
    state.threadsById[threadId]?.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        !message.historyTurnActive &&
        message.segments.some(
          (part) =>
            part.kind === 'tool' &&
            part.detail?.state === 'deferred' &&
            part.detail.turnRef === turnRef,
        ),
    ) ?? [];
  if (targets.length === 0)
    return Promise.reject(new Error('History detail is no longer available'));
  const request = (async () => {
    const response = await agentApi.fetchHistoryTurn(
      threadId,
      canvasId,
      turnRef,
      AbortSignal.timeout(30_000),
    );
    if (response.threadId !== threadId || response.turnRef !== turnRef) {
      throw new Error('History detail identity mismatch');
    }
    const current = useChatStore.getState();
    if (
      useWorkspaceStore.getState().workspaceId !== workspaceId ||
      current.threadsById[threadId]?.historyRevision !== revision
    ) {
      throw new Error('History detail request is obsolete');
    }
    const tools = response.messages.flatMap((message): AssistantToolPart[] =>
      message.role === 'assistant'
        ? message.parts.filter(
            (part): part is AssistantToolPart => part.kind === 'tool',
          )
        : [],
    );
    for (const target of targets) {
      if (target.role !== 'assistant') continue;
      const currentMessage = current.threadsById[threadId]?.messages.find(
        (m) => m.id === target.id,
      );
      if (
        currentMessage?.role !== 'assistant' ||
        currentMessage.historyTurnActive
      )
        continue;
      const replacements = currentMessage.segments.map((part) => {
        if (
          part.kind !== 'tool' ||
          part.detail?.state !== 'deferred' ||
          part.detail.turnRef !== turnRef
        )
          return part;
        const full = tools.find(
          (tool) =>
            tool.toolCallId === part.toolCallId &&
            tool.variant === part.variant,
        );
        if (
          !full ||
          full.detail?.state !== 'inline' ||
          full.detail.turnRef !== turnRef
        ) {
          throw new Error('History detail is incomplete');
        }
        return full;
      });
      current.updateMessage(threadId, target.id, (message) =>
        message === currentMessage
          ? { ...currentMessage, segments: replacements }
          : message,
      );
    }
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function useHistoryToolDetails(turnRef: string) {
  const { threadId, ownerCanvasId } = useChatSession();
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const load = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    try {
      await loadHistoryToolDetails(ownerCanvasId, threadId, turnRef);
      setStatus('idle');
    } catch (error) {
      console.error('[history-details] Could not load tool details', error);
      setStatus('error');
    }
  };
  return { status, load };
}
