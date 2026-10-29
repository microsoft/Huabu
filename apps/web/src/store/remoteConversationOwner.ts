// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { ApiError } from '@/api/_client';
import { getAgentConversationOwner } from '@/api/agent';

import { invalidateConversationTitle } from './conversationTitleStore';

import type { AgentConversationOwnerResponse } from '@huabu/shared';

export const conversationOwnerKey = (
  canvasId: string,
  nodeId: string,
  threadId: string,
) => JSON.stringify([canvasId, nodeId, threadId]);

interface OwnerEntry {
  owner?: AgentConversationOwnerResponse;
  error?: string;
  errorCode?: string;
}

export const useRemoteConversationOwnerStore = create<{
  entries: Record<string, OwnerEntry | undefined>;
}>(() => ({ entries: {} }));

const requests = new Map<string, Promise<AgentConversationOwnerResponse>>();

export function refreshConversationOwner(
  canvasId: string,
  nodeId: string,
  threadId: string,
  options?: { fresh?: boolean },
): Promise<AgentConversationOwnerResponse> {
  const key = conversationOwnerKey(canvasId, nodeId, threadId);
  const existing = requests.get(key);
  if (existing && options?.fresh) {
    // An older poll's outcome cannot confirm or reject a later successful write.
    return Promise.allSettled([existing]).then(() =>
      refreshConversationOwner(canvasId, nodeId, threadId),
    );
  }
  if (existing) return existing.then((owner) => validateOwner(owner, nodeId));
  const request = getAgentConversationOwner(canvasId, threadId)
    .then((owner) => {
      validateOwner(owner, nodeId);
      const previous =
        useRemoteConversationOwnerStore.getState().entries[key]?.owner;
      useRemoteConversationOwnerStore.setState((state) => ({
        entries: { ...state.entries, [key]: { owner } },
      }));
      if (previous?.source.label !== owner.source.label) {
        invalidateConversationTitle(canvasId, threadId);
      }
      return owner;
    })
    .catch((error: unknown) => {
      useRemoteConversationOwnerStore.setState((state) => ({
        entries: {
          ...state.entries,
          [key]: {
            ...(error instanceof TypeError ||
            (error instanceof ApiError &&
              (error.status === 408 ||
                error.status === 429 ||
                error.status >= 500))
              ? { owner: state.entries[key]?.owner }
              : {}),
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof ApiError ? { errorCode: error.code } : {}),
          },
        },
      }));
      throw error;
    })
    .finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

function validateOwner(owner: AgentConversationOwnerResponse, nodeId: string) {
  if (owner.nodeId !== nodeId) {
    throw new Error('The Agent conversation owner changed');
  }
  return owner;
}
