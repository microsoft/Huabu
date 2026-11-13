// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import {
  subscribeCanvasPresence,
  subscribeCanvasSync,
} from './canvasSyncSubscription';

vi.mock('@/api/canvasSync', () => ({
  canvasSyncStreamUrl: (id: string, pageId: string) =>
    `/sync/${id}?pageId=${pageId}`,
}));
vi.mock('./canvasStore/sync/pageId', () => ({ CANVAS_PAGE_ID: 'this-page' }));

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

it('opens the stream as this page, hands presence to presence listeners only, and replays it to a late one', async () => {
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
  const encode = new TextEncoder();
  const send = (data: unknown) =>
    push.enqueue(
      encode.encode(`event: presence\ndata: ${JSON.stringify(data)}\n\n`),
    );
  const other = {
    pageId: 'other',
    colorIndex: 0,
    label: 'Chrome · Mac',
    pointer: null,
    selectedNodeIds: ['n1'],
    draggingNodeIds: [],
    editingNodeIds: [],
  };
  const canvas = vi.fn();
  const presence = { onEvent: vi.fn(), onDisconnect: vi.fn() };
  const late = { onEvent: vi.fn(), onDisconnect: vi.fn() };
  const closeCanvas = subscribeCanvasSync('space', canvas);
  const closePresence = subscribeCanvasPresence('space', presence);
  let closeLate = () => {};
  try {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe('/sync/space?pageId=this-page');
    await vi.waitFor(() => expect(push).toBeDefined());
    send({ op: 'snapshot', pages: [other] });
    send({ op: 'pointer', pageId: 'other', pointer: { x: 1, y: 2 } });
    await vi.waitFor(() => expect(presence.onEvent).toHaveBeenCalledTimes(2));
    expect(presence.onEvent).toHaveBeenNthCalledWith(1, {
      op: 'snapshot',
      pages: [other],
    });
    expect(canvas).not.toHaveBeenCalled();

    closeLate = subscribeCanvasPresence('space', late);
    await vi.waitFor(() =>
      expect(late.onEvent).toHaveBeenCalledWith({
        op: 'snapshot',
        pages: [{ ...other, pointer: { x: 1, y: 2 } }],
      }),
    );
    send({ op: 'leave', pageId: 'other' });
    await vi.waitFor(() => expect(late.onEvent).toHaveBeenCalledTimes(2));

    // The stream is shared: it stays open until the last listener of either kind.
    const options = fetchMock.mock.calls[0][1];
    closeCanvas();
    closePresence();
    expect(options.signal?.aborted).toBe(false);
    closeLate();
    expect(options.signal?.aborted).toBe(true);
  } finally {
    closeCanvas();
    closePresence();
    closeLate();
  }
});

it('tells presence listeners when the stream drops', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(new ReadableStream({ start: (c) => c.close() })),
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const presence = { onEvent: vi.fn(), onDisconnect: vi.fn() };
  const close = subscribeCanvasPresence('dropped', presence);
  try {
    await vi.waitFor(() => expect(presence.onDisconnect).toHaveBeenCalled());
  } finally {
    close();
  }
});
