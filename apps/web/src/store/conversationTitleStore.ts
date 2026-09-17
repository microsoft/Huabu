// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { ApiError } from '@/api/_client';
import {
  queryConversationTitles,
  setConversationTitle,
} from '@/api/conversationTitles';

import type { ConversationTitle } from '@huabu/shared';

interface TitleEntry {
  value: ConversationTitle;
  durable?: boolean;
  renaming?: boolean;
  error?: string;
  failedTitle?: string;
  revision: number;
}

interface TitleState {
  entries: Record<string, TitleEntry>;
  /** Only user intent awaiting durable thread creation survives reload. */
  pending: Record<string, string>;
  refreshEpoch: number;
}

export const conversationTitleKey = (canvasId: string, threadId: string) =>
  JSON.stringify([canvasId, threadId]);

const EMPTY_TITLE: ConversationTitle = { title: null, source: null };

export const useConversationTitleStore = create<TitleState>()(
  persist(() => ({ entries: {}, pending: {}, refreshEpoch: 0 }), {
    name: 'huabu.conversationTitleDrafts',
    version: 1,
    partialize: (state) => ({ pending: state.pending }),
    merge: (persisted, current) => {
      const raw = (persisted as Partial<TitleState> | undefined)?.pending;
      const pending: Record<string, string> = {};
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          try {
            const address: unknown = JSON.parse(key);
            if (
              Array.isArray(address) &&
              address.length === 2 &&
              address.every(
                (part) => typeof part === 'string' && part.length > 0,
              ) &&
              typeof value === 'string' &&
              value.trim() &&
              value.trim().length <= 120
            ) {
              pending[key] = value.trim();
            }
          } catch {
            /* Ignore malformed draft addresses. */
          }
        }
      }
      return { ...current, pending };
    },
  }),
);

function entry(key: string): TitleEntry {
  const cached = useConversationTitleStore.getState().entries[key];
  return cached ?? { value: EMPTY_TITLE, revision: 0 };
}

function patch(key: string, change: Partial<TitleEntry>) {
  useConversationTitleStore.setState((state) => ({
    entries: { ...state.entries, [key]: { ...entry(key), ...change } },
  }));
}

function queuePendingTitle(key: string, title: string) {
  useConversationTitleStore.setState((state) => ({
    pending: { ...state.pending, [key]: title },
  }));
  patch(key, {
    revision: entry(key).revision + 1,
    renaming: false,
    error: undefined,
    failedTitle: undefined,
  });
}

export function getConversationTitle(
  canvasId: string,
  threadId: string,
  state: TitleState = useConversationTitleStore.getState(),
): ConversationTitle {
  const key = conversationTitleKey(canvasId, threadId);
  const pending = state.pending[key];
  return pending
    ? { title: pending, source: 'user' }
    : (state.entries[key]?.value ?? EMPTY_TITLE);
}

const queries = new Map<string, Promise<void>>();
const invalidated = new Set<string>();
const saves = new Map<string, Promise<void>>();
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Failed to save conversation title';

/** Refetch backend facts; events arriving during a read queue one fresh read. */
export function invalidateConversationTitle(
  canvasId: string,
  threadId: string,
) {
  if (!canvasId) return;
  const key = conversationTitleKey(canvasId, threadId);
  patch(key, { durable: true });
  // Do not invalidate the revision of an in-flight manual save. Reads begun
  // during that save are already fenced by the renaming flag.
  if (!entry(key).renaming) patch(key, { revision: entry(key).revision + 1 });
  if (queries.has(key)) invalidated.add(key);
  else void refreshConversationTitles(canvasId, [threadId]);
}

/** Dedupe overlapping requests per namespace/thread, not just identical batches. */
export async function refreshConversationTitles(
  canvasId: string,
  threadIds: string[],
): Promise<void> {
  if (!canvasId) return;
  const waiting = new Set<Promise<void>>();
  const fresh: string[] = [];
  for (const threadId of new Set(threadIds)) {
    const active = queries.get(conversationTitleKey(canvasId, threadId));
    if (active) waiting.add(active);
    else fresh.push(threadId);
  }
  for (let offset = 0; offset < fresh.length; offset += 100) {
    const batch = fresh.slice(offset, offset + 100);
    const revisions = batch.map(
      (id) => entry(conversationTitleKey(canvasId, id)).revision,
    );
    // A read started during a rename may observe pre-save server state even
    // if its response arrives after the save settles (including rollback).
    const duringRename = batch.map(
      (id) => !!entry(conversationTitleKey(canvasId, id)).renaming,
    );
    const request = queryConversationTitles({ canvasId, threadIds: batch })
      .then(async ({ titles }) => {
        await Promise.all(
          batch.map(async (threadId, index) => {
            const key = conversationTitleKey(canvasId, threadId);
            const current = entry(key);
            const value = titles[threadId];
            // The backend owns title policy; only local edit/read ordering
            // can prevent adopting its exact projection, including absence.
            if (
              value &&
              !invalidated.has(key) &&
              !duringRename[index] &&
              !current.renaming &&
              current.revision === revisions[index]
            ) {
              patch(key, {
                value,
                durable: current.durable || !!value.title,
                error: current.failedTitle ? current.error : undefined,
              });
            }
            // An empty title does not imply that the durable thread is absent.
            // Attempt pending intent; 404 retains it for the bounded retry path.
            if (useConversationTitleStore.getState().pending[key])
              await flushPendingConversationTitle(canvasId, threadId);
          }),
        );
      })
      .catch((error: unknown) => {
        batch.forEach((id, index) => {
          const key = conversationTitleKey(canvasId, id);
          if (
            !duringRename[index] &&
            !entry(key).renaming &&
            entry(key).revision === revisions[index]
          )
            patch(key, { error: errorMessage(error) });
        });
      })
      .finally(() => {
        const followup = batch.filter((id) => {
          const key = conversationTitleKey(canvasId, id);
          queries.delete(key);
          return invalidated.delete(key);
        });
        if (followup.length) void refreshConversationTitles(canvasId, followup);
      });
    batch.forEach((id) =>
      queries.set(conversationTitleKey(canvasId, id), request),
    );
    waiting.add(request);
  }
  await Promise.all(waiting);
}

export async function renameConversationTitle(
  canvasId: string,
  threadId: string,
  raw: string,
  isDraft: boolean,
): Promise<void> {
  const title = raw.trim();
  if (!title || title.length > 120)
    throw new Error('Title must contain 1–120 characters');
  const key = conversationTitleKey(canvasId, threadId);
  if (isDraft || useConversationTitleStore.getState().pending[key]) {
    queuePendingTitle(key, title);
    if (entry(key).durable)
      await flushPendingConversationTitle(canvasId, threadId);
    return;
  }
  const previous = entry(key);
  const revision = previous.revision + 1;
  patch(key, {
    value: { title, source: 'user' },
    revision,
    renaming: true,
    error: undefined,
    failedTitle: undefined,
  });
  try {
    const value = await setConversationTitle(canvasId, threadId, { title });
    if (entry(key).revision === revision)
      patch(key, {
        value,
        durable: true,
        renaming: false,
        revision: revision + 1,
      });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === 'thread_not_found'
    ) {
      // First send can precede durable creation. Preserve only the latest
      // rename as a draft and let the existing refresh/stream path flush it.
      if (entry(key).revision === revision) {
        patch(key, { value: previous.value });
        queuePendingTitle(key, title);
      }
      return;
    }
    if (entry(key).revision === revision)
      patch(key, {
        value: previous.value,
        renaming: false,
        revision: revision + 1,
        error: errorMessage(error),
        failedTitle: title,
      });
    throw error;
  }
}

/** A 404 is an expected creation race; keep the draft until a later refresh. */
export function flushPendingConversationTitle(
  canvasId: string,
  threadId: string,
): Promise<void> {
  const key = conversationTitleKey(canvasId, threadId);
  const active = saves.get(key);
  if (active) return active;
  if (!useConversationTitleStore.getState().pending[key])
    return Promise.resolve();
  const request = (async () => {
    while (useConversationTitleStore.getState().pending[key]) {
      const title = useConversationTitleStore.getState().pending[key];
      try {
        const value = await setConversationTitle(canvasId, threadId, { title });
        if (useConversationTitleStore.getState().pending[key] !== title)
          continue;
        patch(key, {
          value,
          durable: true,
          error: undefined,
          revision: entry(key).revision + 1,
        });
        useConversationTitleStore.setState((state) => {
          const pending = { ...state.pending };
          delete pending[key];
          return { pending };
        });
      } catch (error) {
        patch(key, {
          error:
            error instanceof ApiError && error.status === 404
              ? undefined
              : errorMessage(error),
        });
        break;
      }
    }
  })().finally(() => saves.delete(key));
  saves.set(key, request);
  return request;
}

export function refreshConversationTitleAfterStream(
  canvasId: string,
  threadId: string,
) {
  void flushPendingConversationTitle(canvasId, threadId).then(() =>
    invalidateConversationTitle(canvasId, threadId),
  );
  useConversationTitleStore.setState((state) => ({
    refreshEpoch: state.refreshEpoch + 1,
  }));
}

export async function retryConversationTitle(
  canvasId: string,
  threadId: string,
) {
  const failed = entry(conversationTitleKey(canvasId, threadId)).failedTitle;
  if (failed) {
    // The error remains observable in the store if the explicit retry fails.
    await renameConversationTitle(canvasId, threadId, failed, false).catch(
      () => {},
    );
  } else {
    await refreshConversationTitles(canvasId, [threadId]);
  }
}

/** Successful conversion transfers user intent to the canonical node label. */
export function clearPendingConversationTitle(
  canvasId: string,
  threadId: string,
) {
  const key = conversationTitleKey(canvasId, threadId);
  useConversationTitleStore.setState((state) => {
    const pending = { ...state.pending };
    delete pending[key];
    return { pending };
  });
}

export function needsConversationTitleRefresh(
  canvasId: string,
  threadId: string,
) {
  const key = conversationTitleKey(canvasId, threadId);
  const current = entry(key);
  return (
    !!useConversationTitleStore.getState().pending[key] ||
    !!current.error ||
    current.value.source === 'fallback' ||
    current.value.source === 'acp' ||
    (!!current.durable && !current.value.title)
  );
}
