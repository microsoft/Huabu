// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  extractTitleFromText,
  normalizeAcpConversationTitle,
  normalizeConversationTitle,
} from '@huabu/shared/conversation-title';

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
const priority = { user: 4, generated: 3, acp: 2, fallback: 1 };
const rank = (value: ConversationTitle) =>
  value.source ? priority[value.source] : 0;

/** Validate before display or ranking, including cache entries retained by HMR. */
function normalizeTitleValue(value: ConversationTitle): ConversationTitle {
  const title =
    value.source === 'acp'
      ? normalizeAcpConversationTitle(value.title)
      : normalizeConversationTitle(value.title);
  if (!title) return EMPTY_TITLE;
  return title === value.title ? value : { ...value, title };
}

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
  return cached
    ? { ...cached, value: normalizeTitleValue(cached.value) }
    : { value: EMPTY_TITLE, revision: 0 };
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
    : normalizeTitleValue(state.entries[key]?.value ?? EMPTY_TITLE);
}

export function seedConversationTitle(
  canvasId: string,
  threadId: string,
  prompt: string,
) {
  const key = conversationTitleKey(canvasId, threadId);
  const title = normalizeConversationTitle(extractTitleFromText(prompt));
  if (title && !entry(key).value.title)
    patch(key, { value: { title, source: 'fallback' } });
}

export function receiveAcpConversationTitle(
  canvasId: string,
  threadId: string,
  raw: string | null | undefined,
) {
  const title = normalizeAcpConversationTitle(raw);
  const key = conversationTitleKey(canvasId, threadId);
  const value: ConversationTitle = { title, source: 'acp' };
  if (!title || rank(getConversationTitle(canvasId, threadId)) > rank(value))
    return;
  patch(key, {
    value,
    durable: true,
    revision: entry(key).revision + 1,
  });
}

const queries = new Map<string, Promise<void>>();
const saves = new Map<string, Promise<void>>();
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Failed to save conversation title';

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
            const received = titles[threadId];
            const value = received && normalizeTitleValue(received);
            // A newer ACP event must not discard a generated upgrade. Keep
            // revision protection for equal-ranked results, especially renames.
            if (
              value &&
              !duringRename[index] &&
              !current.renaming &&
              (current.revision === revisions[index] ||
                rank(value) > rank(current.value))
            ) {
              patch(key, {
                value:
                  rank(value) >= rank(current.value) ? value : current.value,
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
        batch.forEach((id) =>
          queries.delete(conversationTitleKey(canvasId, id)),
        );
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
    refreshConversationTitles(canvasId, [threadId]),
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
