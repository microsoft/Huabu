// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSSEStream } from './_sse';

const encoder = new TextEncoder();

describe('readSSEStream inactivity timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects and cancels a stream that receives no data', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
    });
    const reading = readSSEStream(new Response(stream), vi.fn(), undefined, {
      inactivityTimeoutMs: 1_000,
    });
    const rejection = expect(reading).rejects.toThrow(
      'SSE stream received no data for 1000 ms',
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('treats heartbeat comments as activity', async () => {
    const streamState: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
    } = {};
    const onEvent = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        streamState.controller = nextController;
      },
    });
    const reading = readSSEStream(new Response(stream), onEvent, undefined, {
      inactivityTimeoutMs: 1_000,
    });
    const enqueue = (value: string) => {
      const controller = streamState.controller;
      if (!controller) throw new Error('Stream controller was not initialized');
      controller.enqueue(encoder.encode(value));
    };

    await vi.advanceTimersByTimeAsync(900);
    enqueue(': ping\n\n');
    await vi.advanceTimersByTimeAsync(900);
    enqueue('event: update\ndata: {"version":2}\n\n');
    const controller = streamState.controller;
    if (!controller) {
      throw new Error('Stream controller was not initialized');
    }
    controller.close();
    await reading;

    expect(onEvent).toHaveBeenCalledWith({
      type: 'update',
      data: { version: 2 },
    });
  });
});
