// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentApi } from './agent';

import type { ApiError } from './_client';
import type { AgentStreamCallbacks } from './agent';
import type { AgentHostStreamEvent } from '@huabu/shared';

function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function callbacks(): AgentStreamCallbacks {
  return {
    onEvent: vi.fn(),
    onAccepted: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

function respond(events: AgentHostStreamEvent[]) {
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          events.map((event) => frame(event.type, event.data)).join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('agent API host acceptance', () => {
  it('sends quoted comments as structured input rather than interpolating the prompt', async () => {
    const fetchMock = respond([{ type: 'end', data: {} }]);
    const quotedComments = [
      {
        quote: 'Original reply',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
      },
    ];
    await agentApi.streamMessage('', 'thread-a', 'operate', callbacks(), {
      quotedComments,
    });
    const options = fetchMock.mock.calls[0]?.[1];
    if (typeof options?.body !== 'string')
      throw new Error('Missing request body');
    expect(JSON.parse(options.body)).toMatchObject({
      content: '',
      quotedComments,
    });
    expect(options.body).not.toContain('<quoted_comments>');
  });

  it('sends hidden visible-Canvas grounding with an Ink request', async () => {
    const fetchMock = respond([{ type: 'end', data: {} }]);
    const groundingVisual = {
      kind: 'visible-canvas' as const,
      dataUrl: 'data:image/png;base64,cG5n',
      viewport: {
        x: 0,
        y: 0,
        zoom: 1,
        width: 100,
        height: 100,
        devicePixelRatio: 1,
      },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      selectedNodeIds: ['note-1'],
      strokeSubsets: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
    };
    const inkResources = [
      {
        id: 'sigil',
        fingerprint: '0123456789abcdef',
        targetNodeId: 'paper',
        targetType: 'pdf' as const,
        label: 'Paper',
        sourceBounds: { x: 0, y: 0, width: 40, height: 40 },
        sources: [1, 2, 3, 4].map((i) => ({
          nodeId: 'sketch-1',
          strokeId: `stroke-${i}`,
        })),
      },
    ];

    await agentApi.streamMessage('', 'thread-a', 'operate', callbacks(), {
      inputKind: 'ink-intent',
      canvasId: 'canvas-a',
      canvasContext: {
        selectedNodes: [
          { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
          { id: 'note-1', type: 'note' },
        ],
      },
      groundingVisual,
      inkResources,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.groundingVisual).toEqual(groundingVisual);
    expect(body.inkResources).toEqual(inkResources);
  });

  it('returns durable acceptance from stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            stopped: true,
            acceptance: { threadId: 'thread-a', turnStartSeq: 2 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(agentApi.stopThread('thread-a', 'canvas-a')).resolves.toEqual({
      stopped: true,
      acceptance: { threadId: 'thread-a', turnStartSeq: 2 },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/agent/stop/thread-a?canvasId=canvas-a'),
      expect.anything(),
    );
  });

  it('preserves an unknown stop outcome as a rejected request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(agentApi.stopThread('thread-a')).rejects.toThrow('offline');
  });

  it.each([
    { data: null },
    { data: {} },
    { data: { threadId: '', turnStartSeq: 1 } },
    { data: { threadId: 'thread-a', turnStartSeq: 0 } },
    { data: { threadId: 'thread-a', turnStartSeq: -1 } },
    { data: { threadId: 'thread-a', turnStartSeq: 1.5 } },
    { data: { threadId: 'thread-a', turnStartSeq: '1' } },
  ])('rejects invalid acceptance payload $data', async ({ data }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(frame('accepted', data))),
    );
    const handlers = callbacks();
    await agentApi.streamMessage('', 'thread-a', 'operate', handlers, {
      inputKind: 'ink-intent',
    });
    expect(handlers.onAccepted).not.toHaveBeenCalled();
    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Invalid agent acceptance'),
    );
  });

  it('delivers acceptance before stream completion without changing onEvent', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    const handlers = callbacks();
    const pending = agentApi.streamMessage(
      '',
      'thread-a',
      'operate',
      handlers,
      { inputKind: 'ink-intent' },
    );
    const encoder = new TextEncoder();
    const accepted = { threadId: 'thread-a', turnStartSeq: 7 };
    try {
      controller.enqueue(encoder.encode(frame('accepted', accepted)));
      await vi.waitFor(() =>
        expect(handlers.onAccepted).toHaveBeenCalledExactlyOnceWith(accepted),
      );
      expect(handlers.onEvent).not.toHaveBeenCalled();
      expect(handlers.onComplete).not.toHaveBeenCalled();
    } finally {
      controller.enqueue(
        encoder.encode(
          frame('text_delta', { content: 'Answer' }) + frame('end', {}),
        ),
      );
      controller.close();
      await pending;
    }
    expect(handlers.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'text_delta',
      data: { content: 'Answer' },
    });
    expect(handlers.onComplete).toHaveBeenCalledOnce();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('sends inputKind only when supplied and preserves empty Ink content', async () => {
    const fetchMock = respond([{ type: 'end', data: {} }]);
    await agentApi.streamMessage('', 'thread-a', 'ask', callbacks(), {
      inputKind: 'ink-intent',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      content: '',
      inputKind: 'ink-intent',
      mode: 'ask',
    });
    await agentApi.streamMessage('Hello', 'thread-b', 'ask', callbacks());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      'inputKind',
    );
  });

  it('keeps onAccepted optional for existing event consumers', async () => {
    respond([
      { type: 'accepted', data: { threadId: 'thread-a', turnStartSeq: 1 } },
      { type: 'text_delta', data: { content: 'Legacy' } },
      { type: 'end', data: {} },
    ]);
    const handlers = {
      onEvent: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
    };
    await agentApi.streamMessage('Hello', 'thread-a', 'ask', handlers);
    expect(handlers.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'text_delta',
      data: { content: 'Legacy' },
    });
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onComplete).toHaveBeenCalledOnce();
  });

  it('does not infer acceptance from meta or from a preparation error', async () => {
    respond([
      { type: 'meta', data: { threadId: 'thread-a', mode: 'operate' } },
      { type: 'error', data: { error: 'Ink could not be prepared' } },
      { type: 'accepted', data: { threadId: 'thread-a', turnStartSeq: 1 } },
      { type: 'end', data: {} },
    ]);
    const handlers = callbacks();
    await agentApi.streamMessage('', 'thread-a', 'operate', handlers, {
      inputKind: 'ink-intent',
    });
    expect(handlers.onAccepted).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Ink could not be prepared'),
    );
    expect(handlers.onComplete).not.toHaveBeenCalled();
  });

  it('preserves a structured pre-stream rejection for retry classification', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'Select the strokes again.',
            code: 'ink_visual_unavailable',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );
    const handlers = callbacks();

    await agentApi.streamMessage('', 'thread-a', 'operate', handlers, {
      inputKind: 'ink-intent',
    });

    expect(handlers.onAccepted).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining<Partial<ApiError>>({
        name: 'ApiError',
        message: 'Select the strokes again.',
        status: 409,
        code: 'ink_visual_unavailable',
      }),
    );
  });

  it('shares acceptance parsing with reconnect while suppressing meta', async () => {
    const accepted = { threadId: 'thread-a', turnStartSeq: 3 };
    respond([
      { type: 'meta', data: { threadId: 'thread-a', mode: 'ask' } },
      { type: 'accepted', data: accepted },
      { type: 'end', data: {} },
    ]);
    const handlers = callbacks();
    await expect(
      agentApi.reconnectStream('thread-a', 'canvas-a', handlers),
    ).resolves.toEqual({ status: 'completed' });
    expect(handlers.onAccepted).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(handlers.onEvent).not.toHaveBeenCalled();
  });

  it('rejects with stream error if stream reaches EOF without a terminal event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    respond([{ type: 'text_delta', data: { content: 'Partial response' } }]);
    const handlers = callbacks();

    await agentApi.streamMessage('Hello', 'thread-a', 'ask', handlers);

    expect(handlers.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'text_delta',
      data: { content: 'Partial response' },
    });
    expect(handlers.onComplete).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: 'Agent stream ended before a terminal event',
      }),
    );
  });

  it('calls onComplete when stream terminates after a done event', async () => {
    respond([
      { type: 'text_delta', data: { content: 'Full response' } },
      { type: 'done', data: { message: 'Turn complete' } },
    ]);
    const handlers = callbacks();

    await agentApi.streamMessage('Hello', 'thread-a', 'ask', handlers);

    expect(handlers.onEvent).toHaveBeenCalledTimes(2);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onComplete).toHaveBeenCalledOnce();
  });

  it('treats aborted stream without terminal event as intentional stop', async () => {
    respond([{ type: 'text_delta', data: { content: 'Interrupted' } }]);
    const handlers = callbacks();
    const controller = new AbortController();
    controller.abort();

    await agentApi.streamMessage('Hello', 'thread-a', 'ask', handlers, {
      signal: controller.signal,
    });

    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onComplete).toHaveBeenCalledOnce();
  });
});
