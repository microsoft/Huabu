// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { subscribeCanvasSync } from './canvasSyncSubscription';

vi.mock('@/api/canvasSync', () => ({
  canvasSyncStreamUrl: (id: string) => `/sync/${id}`,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shares a stream per Space, supplies the latest baseline to late viewers, and aborts the final release', async () => {
  let push!: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = controller;
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const canvas = vi.fn();
  const conversation = vi.fn();
  const closeCanvas = subscribeCanvasSync('child', canvas);
  const encode = new TextEncoder();
  push.enqueue(encode.encode('event: snapshot\ndata: {"version":1}\n\n'));
  await vi.waitFor(() => expect(canvas).toHaveBeenCalledOnce());
  const closeConversation = subscribeCanvasSync('child', conversation);
  try {
    await vi.waitFor(() =>
      expect(conversation).toHaveBeenCalledWith({
        type: 'snapshot',
        data: { version: 1 },
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    closeCanvas();
    const options = fetchMock.mock.calls[0][1];
    expect(options.signal?.aborted).toBe(false);
    push.enqueue(
      encode.encode('event: invalidate\ndata: {"nodeIds":["agent"]}\n\n'),
    );
    await vi.waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
    expect(canvas).toHaveBeenCalledOnce();
    closeConversation();
    expect(options.signal?.aborted).toBe(true);
  } finally {
    closeCanvas();
    closeConversation();
  }
});
