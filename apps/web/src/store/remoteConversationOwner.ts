// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { ApiError, getRateLimitRetryAfterSeconds } from '@/api/_client';
import {
  getAgentConversationOwner,
  streamAgentConversationOwner,
} from '@/api/agent';
import { hasAgentStreamClaim } from '@/hooks/agentStreamCoordinator';

import { useChatStore } from './chatStore';
import { invalidateConversationTitle } from './conversationTitleStore';
import { useWorkspaceStore } from './workspaceStore';

import type {
  AgentConversationOwnerObservation,
  AgentConversationOwnerResponse,
} from '@huabu/shared';

export const conversationOwnerKey = (
  canvasId: string,
  nodeId: string,
  threadId: string,
) => JSON.stringify([canvasId, nodeId, threadId]);

interface OwnerEntry {
  owner?: AgentConversationOwnerResponse;
  lastKnownOwner?: AgentConversationOwnerResponse;
  error?: string;
  errorCode?: string;
  errorStatus?: number;
  observation?: AgentConversationOwnerObservation;
}

export const useRemoteConversationOwnerStore = create<{
  entries: Record<string, OwnerEntry | undefined>;
}>(() => ({ entries: {} }));

type OwnerRequest = {
  promise: Promise<AgentConversationOwnerResponse>;
  controller: AbortController;
  readers: number;
};
const requests = new Map<string, OwnerRequest>();
const snapshotSerials = new Map<string, number>();

function failureObservation(
  error: unknown,
): AgentConversationOwnerObservation | undefined {
  const details = error instanceof ApiError ? error.details : undefined;
  if (!details || typeof details !== 'object' || !('observation' in details))
    return undefined;
  const value = details.observation;
  if (
    value &&
    typeof value === 'object' &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
  )
    return { epoch: value.epoch, revision: value.revision };
  return undefined;
}

function isSuperseded(
  key: string,
  observation?: AgentConversationOwnerObservation,
  snapshotSerial?: number,
) {
  const current =
    useRemoteConversationOwnerStore.getState().entries[key]?.observation;
  if (current && observation && current.epoch === observation.epoch)
    return observation.revision < current.revision;
  return snapshotSerials.get(key) !== snapshotSerial;
}

function publishOwner(
  key: string,
  owner: AgentConversationOwnerResponse,
  workspaceId: string | null,
) {
  const previous =
    useRemoteConversationOwnerStore.getState().entries[key]?.owner;
  useRemoteConversationOwnerStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: { owner, lastKnownOwner: owner, observation: owner.observation },
    },
  }));
  if (previous?.source.label !== owner.source.label)
    invalidateConversationTitle(owner.canvasId, owner.threadId);
  const workspace = useWorkspaceStore.getState();
  if (
    workspace.workspaceId === workspaceId &&
    workspace.spaceTitles[owner.canvasId] !== owner.spaceTitle
  )
    workspace.setSpaceTitle(owner.canvasId, owner.spaceTitle);
}

function publishFailure(key: string, error: unknown) {
  useRemoteConversationOwnerStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: {
        lastKnownOwner: state.entries[key]?.lastKnownOwner,
        observation:
          failureObservation(error) ?? state.entries[key]?.observation,
        ...(error instanceof TypeError ||
        (error instanceof ApiError &&
          (error.status === 408 || error.status === 429 || error.status >= 500))
          ? { owner: state.entries[key]?.owner }
          : {}),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          ? { errorCode: error.code, errorStatus: error.status }
          : {}),
      },
    },
  }));
}

function currentOwner(key: string): AgentConversationOwnerResponse {
  const entry = useRemoteConversationOwnerStore.getState().entries[key];
  if (entry?.owner && !entry.error) return entry.owner;
  throw new ApiError(
    entry?.errorStatus ?? 409,
    { code: entry?.errorCode, details: { observation: entry?.observation } },
    entry?.error ?? 'The conversation state changed during validation',
  );
}

function readSharedOwner(
  request: OwnerRequest,
  signal?: AbortSignal,
): Promise<AgentConversationOwnerResponse> {
  request.readers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error?: unknown,
      owner?: AgentConversationOwnerResponse,
    ) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      request.readers--;
      if (request.readers === 0) request.controller.abort();
      if (owner) resolve(owner);
      else reject(error);
    };
    const abort = () => finish(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    void request.promise.then(
      (owner) => finish(undefined, owner),
      (error) => finish(error),
    );
    if (signal?.aborted) abort();
  });
}

export function refreshConversationOwner(
  canvasId: string,
  nodeId: string,
  threadId: string,
  options?: { fresh?: boolean; signal?: AbortSignal },
): Promise<AgentConversationOwnerResponse> {
  const key = conversationOwnerKey(canvasId, nodeId, threadId);
  if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
  const pending = requests.get(key);
  const existing = pending?.controller.signal.aborted ? undefined : pending;
  if (existing && options?.fresh) {
    // An older poll's outcome cannot confirm or reject a later successful write.
    return Promise.allSettled([readSharedOwner(existing, options.signal)]).then(
      () =>
        refreshConversationOwner(canvasId, nodeId, threadId, {
          signal: options.signal,
        }),
    );
  }
  if (existing)
    return readSharedOwner(existing, options?.signal).then((owner) =>
      validateOwner(owner, nodeId),
    );
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  const snapshotSerial = snapshotSerials.get(key);
  const controller = new AbortController();
  const promise = getAgentConversationOwner(
    canvasId,
    threadId,
    controller.signal,
  )
    .then((owner) => {
      controller.signal.throwIfAborted();
      if (isSuperseded(key, owner.observation, snapshotSerial))
        return currentOwner(key);
      validateOwner(owner, nodeId);
      publishOwner(key, owner, workspaceId);
      return owner;
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      if (isSuperseded(key, failureObservation(error), snapshotSerial))
        return currentOwner(key);
      publishFailure(key, error);
      throw error;
    })
    .finally(() => {
      if (requests.get(key) === request) requests.delete(key);
    });
  const request: OwnerRequest = { controller, readers: 0, promise };
  requests.set(key, request);
  return readSharedOwner(request, options?.signal);
}

function validateOwner(owner: AgentConversationOwnerResponse, nodeId: string) {
  if (owner.nodeId !== nodeId) {
    throw new Error('The Agent conversation owner changed');
  }
  return owner;
}

const observers = new Map<
  string,
  {
    listeners: Set<() => void>;
    address: { canvasId: string; nodeId: string; threadId: string };
    refresh: () => void;
    dispose: () => void;
    validated: boolean;
  }
>();

/** Observe an address, independently of the Space presenting its conversation. */
export function subscribeConversationOwner(
  canvasId: string,
  nodeId: string,
  threadId: string,
  onRefresh?: () => void,
): () => void {
  const key = conversationOwnerKey(canvasId, nodeId, threadId);
  let observer = observers.get(key);
  if (!observer) {
    const listeners = new Set<() => void>();
    let disposed = false;
    let retryDelay = 500;
    let retryNotBefore = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const workspaceId = useWorkspaceStore.getState().workspaceId;
    const refresh = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      if (Date.now() < retryNotBefore) {
        timer = setTimeout(() => refresh(), retryNotBefore - Date.now());
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const currentObserver = observers.get(key);
      if (currentObserver) currentObserver.validated = false;
      const { signal } = controller;
      let streamId: string | undefined;
      let revision = 0;
      void streamAgentConversationOwner(
        canvasId,
        threadId,
        (event) => {
          if (disposed || signal.aborted) return;
          const snapshot = event.data;
          if (streamId !== undefined && snapshot.streamId !== streamId) return;
          if (snapshot.revision <= revision) return;
          const calibrate =
            revision === 0 ||
            snapshot.revision !== revision + 1 ||
            !!useRemoteConversationOwnerStore.getState().entries[key]?.error;
          streamId = snapshot.streamId;
          revision = snapshot.revision;
          const observation =
            snapshot.value.state === 'ready'
              ? snapshot.value.owner.observation
              : snapshot.value.error.details?.observation;
          const currentEntry =
            useRemoteConversationOwnerStore.getState().entries[key];
          if (
            observation &&
            currentEntry?.observation?.epoch === observation.epoch &&
            observation.revision < currentEntry.observation.revision
          ) {
            if (currentEntry.owner && !currentEntry.error) {
              if (currentObserver) currentObserver.validated = true;
              for (const listener of listeners) listener();
            }
            return;
          }
          snapshotSerials.set(key, (snapshotSerials.get(key) ?? 0) + 1);
          retryDelay = 500;
          retryNotBefore = 0;
          clearTimeout(timer);
          if (snapshot.value.state === 'unavailable') {
            publishFailure(
              key,
              new ApiError(
                snapshot.value.status,
                snapshot.value.error,
                snapshot.value.error.message,
              ),
            );
            return;
          }
          try {
            validateOwner(snapshot.value.owner, nodeId);
          } catch (error) {
            publishFailure(key, error);
            return;
          }
          publishOwner(key, snapshot.value.owner, workspaceId);
          if (currentObserver) currentObserver.validated = true;
          if (calibrate && !hasAgentStreamClaim(canvasId, threadId)) {
            useChatStore.getState().setHistoryError(threadId, null);
            useChatStore.getState().setHistoryLoaded(threadId, false);
          }
          for (const listener of listeners) listener();
        },
        signal,
      ).catch((error: unknown) => {
        if (disposed || signal.aborted) return;
        console.error('[conversationOwner] observation failed', error);
        publishFailure(
          key,
          error instanceof ApiError
            ? error
            : new ApiError(
                503,
                {},
                error instanceof Error
                  ? error.message
                  : 'Unable to observe the conversation',
              ),
        );
        if (
          error instanceof ApiError &&
          error.status !== 408 &&
          error.status !== 429 &&
          error.status < 500
        )
          return;
        const retryAfter = getRateLimitRetryAfterSeconds(error);
        retryNotBefore =
          Date.now() + Math.max(retryDelay, (retryAfter ?? 0) * 1000);
        timer = setTimeout(refresh, retryNotBefore - Date.now());
        retryDelay = Math.min(retryDelay * 2, 10_000);
      });
    };
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    observer = {
      listeners,
      validated: false,
      address: { canvasId, nodeId, threadId },
      refresh,
      dispose: () => {
        disposed = true;
        controller?.abort();
        clearTimeout(timer);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisible);
      },
    };
    observers.set(key, observer);
  }

  const current = observer;
  const listener = () => onRefresh?.();
  current.listeners.add(listener);
  if (current.listeners.size === 1) current.refresh();
  else if (
    current.validated &&
    !useRemoteConversationOwnerStore.getState().entries[key]?.error
  )
    listener();
  return () => {
    if (!current.listeners.delete(listener)) return;
    if (current.listeners.size === 0) {
      current.dispose();
      if (observers.get(key) === current) observers.delete(key);
    }
  };
}

export function retryConversationOwnerObservation(
  canvasId: string,
  nodeId: string,
  threadId: string,
) {
  const observer = observers.get(
    conversationOwnerKey(canvasId, nodeId, threadId),
  );
  if (!observer)
    throw new Error('The conversation is no longer being observed');
  observer.refresh();
}

export function findObservedConversation(canvasId: string, nodeId: string) {
  for (const observer of observers.values()) {
    if (
      observer.address.canvasId === canvasId &&
      observer.address.nodeId === nodeId
    )
      return observer.address;
  }

  for (const entry of Object.values(
    useRemoteConversationOwnerStore.getState().entries,
  )) {
    const owner = entry?.lastKnownOwner;
    if (owner?.canvasId === canvasId && owner.nodeId === nodeId) {
      return { canvasId, nodeId, threadId: owner.threadId };
    }
  }
}
