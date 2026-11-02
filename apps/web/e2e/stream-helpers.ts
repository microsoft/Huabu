// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Page } from '@playwright/test';

// Marked responses become held-open SSE streams; tests publish frames independently.
export async function installStreams(page: Page) {
  await page.addInitScript(() => {
    const active: Record<string, number> = {};
    window.addEventListener('test-stream-count', (event) => {
      const detail = (event as CustomEvent<{ key: string; count: number }>)
        .detail;
      detail.count = active[detail.key] ?? 0;
    });
    localStorage.setItem('huabu.language', 'en');
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
    });
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!response.headers.has('x-test-stream')) return response;
      const { key, events } = (await response.json()) as {
        key: string;
        events: Array<{ type: string; data: unknown }>;
      };
      const encoder = new TextEncoder();
      const signal = init?.signal;
      let cleanup = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          active[key] = (active[key] ?? 0) + 1;
          let closed = false;
          const emit = (event: { type: string; data: unknown }) =>
            controller.enqueue(
              encoder.encode(
                `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
              ),
            );
          const onFrame = (event: Event) => {
            const detail = (
              event as CustomEvent<{
                key: string;
                event: { type: string; data: unknown };
                close: boolean;
              }>
            ).detail;
            if (detail.key !== key) return;
            emit(detail.event);
            if (detail.close) {
              cleanup();
              controller.close();
            }
          };
          const onAbort = () => {
            cleanup();
            controller.error(new DOMException('Aborted', 'AbortError'));
          };
          cleanup = () => {
            if (closed) return;
            closed = true;
            active[key]--;
            window.removeEventListener('test-stream-frame', onFrame);
            signal?.removeEventListener('abort', onAbort);
          };
          window.addEventListener('test-stream-frame', onFrame);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
            return;
          }
          for (const event of events) emit(event);
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  });
}

export async function publish(
  page: Page,
  key: string,
  event: { type: string; data: unknown },
  close = false,
) {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent('test-stream-frame', { detail }));
    },
    { key, event, close },
  );
}
