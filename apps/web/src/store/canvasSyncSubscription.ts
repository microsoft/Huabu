// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  apiErrorFromResponse,
  getRateLimitRetryAfterSeconds,
} from '@/api/_client';
import { readTypedSSEStream } from '@/api/_sse';
import { canvasSyncStreamUrl } from '@/api/canvasSync';

import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';

import type {
  CanvasPresenceEvent,
  CanvasPresenceEventData,
  CanvasPresencePage,
  CanvasSyncEvent,
} from '@huabu/shared';

type Listener = (event: CanvasSyncEvent) => void;

/** Receives the stream's `presence` events and learns when the stream drops. */
export interface CanvasPresenceListener {
  onEvent: (event: CanvasPresenceEventData) => void;
  /** The stream ended or failed; presence is unknown until the next snapshot. */
  onDisconnect: () => void;
}

interface Subscription {
  controller: AbortController;
  listeners: Set<Listener>;
  presenceListeners: Set<CanvasPresenceListener>;
  /**
   * The other pages as of the last presence event, for a listener that
   * subscribes after the stream's snapshot; `null` while not connected.
   */
  presencePages: Map<string, CanvasPresencePage> | null;
  version?: number;
  /**
   * The content position this stream has reached: the server's sequence of
   * node-content saves, as of the last snapshot or `invalidate`. Sent when
   * the stream is opened again, so the server can name the nodes saved while
   * it was down.
   */
  content?: { epoch: string; seq: number };
}

const subscriptions = new Map<string, Subscription>();

function trackPresence(
  subscription: Subscription,
  event: CanvasPresenceEventData,
): void {
  if (event.op === 'snapshot') {
    subscription.presencePages = new Map(
      event.pages.map((page) => [page.pageId, page]),
    );
    return;
  }
  const pages = subscription.presencePages;
  if (!pages) return;
  if (event.op === 'update') pages.set(event.page.pageId, event.page);
  else if (event.op === 'leave') pages.delete(event.pageId);
  else {
    const page = pages.get(event.pageId);
    if (page) pages.set(event.pageId, { ...page, pointer: event.pointer });
  }
}

function notifyPresence(
  subscription: Subscription,
  notify: (listener: CanvasPresenceListener) => void,
): void {
  for (const listener of subscription.presenceListeners) {
    try {
      notify(listener);
    } catch (error) {
      console.error('[canvasSync] presence subscriber failed', error);
    }
  }
}

function release(canvasId: string, subscription: Subscription): void {
  if (subscription.listeners.size + subscription.presenceListeners.size > 0)
    return;
  subscription.controller.abort();
  if (subscriptions.get(canvasId) === subscription)
    subscriptions.delete(canvasId);
}

/** The Space's one stream, opened on first use. */
function acquire(canvasId: string): Subscription {
  let subscription = subscriptions.get(canvasId);
  if (!subscription) {
    subscription = {
      controller: new AbortController(),
      listeners: new Set(),
      presenceListeners: new Set(),
      presencePages: null,
    };
    subscriptions.set(canvasId, subscription);
    const current = subscription;
    const { signal } = current.controller;
    void (async () => {
      let delay = 500;
      while (!signal.aborted) {
        let nextDelay = delay;
        try {
          const response = await fetch(
            canvasSyncStreamUrl(canvasId, CANVAS_PAGE_ID, current.content),
            { signal },
          );
          if (!response.ok)
            throw await apiErrorFromResponse(
              response,
              `Canvas sync failed with HTTP ${response.status}`,
            );
          if (!response.body)
            throw new Error('Canvas sync response has no stream');
          await readTypedSSEStream<CanvasSyncEvent | CanvasPresenceEvent>(
            response,
            (event) => {
              if (signal.aborted) return;
              if (event.type === 'presence') {
                trackPresence(current, event.data);
                notifyPresence(current, (listener) =>
                  listener.onEvent(event.data),
                );
                return;
              }
              if (
                event.type !== 'snapshot' &&
                event.type !== 'update' &&
                event.type !== 'invalidate'
              )
                return;
              delay = 500;
              if (event.type !== 'invalidate')
                current.version =
                  event.type === 'snapshot'
                    ? event.data.version
                    : event.data.toVersion;
              if (event.type === 'snapshot' && event.data.content) {
                const { epoch, seq } = event.data.content;
                current.content = { epoch, seq };
              } else if (
                event.type === 'invalidate' &&
                event.data.contentSeq !== undefined &&
                current.content &&
                event.data.contentSeq > current.content.seq
              ) {
                current.content = {
                  ...current.content,
                  seq: event.data.contentSeq,
                };
              }
              for (const receive of current.listeners) {
                try {
                  receive(event);
                } catch (error) {
                  console.error('[canvasSync] subscriber failed', error);
                }
              }
            },
            signal,
            { inactivityTimeoutMs: 45_000 },
          );
          if (!signal.aborted)
            throw new Error('Canvas sync stream ended unexpectedly');
        } catch (error) {
          if (signal.aborted) return;
          const retryAfter = getRateLimitRetryAfterSeconds(error);
          if (retryAfter !== null)
            nextDelay = Math.max(nextDelay, retryAfter * 1000);
          console.warn('[canvasSync] reconnecting after stream failure', error);
        }
        if (signal.aborted) return;
        current.presencePages = null;
        notifyPresence(current, (listener) => listener.onDisconnect());
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, nextDelay);
          signal.addEventListener('abort', finish, { once: true });
        });
        delay = Math.min(delay * 2, 10_000);
      }
    })();
  }
  return subscription;
}

/** Canvas rendering and conversation observation share one transport per Space. */
export function subscribeCanvasSync(
  canvasId: string,
  listener: Listener,
): () => void {
  const current = acquire(canvasId);
  current.listeners.add(listener);
  if (current.version !== undefined) {
    queueMicrotask(() => {
      if (current.listeners.has(listener) && current.version !== undefined)
        listener({ type: 'snapshot', data: { version: current.version } });
    });
  }
  return () => {
    if (!current.listeners.delete(listener)) return;
    release(canvasId, current);
  };
}

/**
 * Space presence rides the same stream. A listener added after the stream's
 * presence snapshot is given the current set as a snapshot of its own.
 */
export function subscribeCanvasPresence(
  canvasId: string,
  listener: CanvasPresenceListener,
): () => void {
  const current = acquire(canvasId);
  current.presenceListeners.add(listener);
  if (current.presencePages) {
    queueMicrotask(() => {
      if (current.presenceListeners.has(listener) && current.presencePages)
        listener.onEvent({
          op: 'snapshot',
          pages: [...current.presencePages.values()],
        });
    });
  }
  return () => {
    if (!current.presenceListeners.delete(listener)) return;
    release(canvasId, current);
  };
}
