// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isInkOcrConfigured, recognizeInk } from './ink-ocr.js';

vi.mock('../../integrations/ink-ocr-config.js', () => ({
  resolveInkOcrConfiguration: () => ({
    key: process.env.VISION_KEY?.trim() || null,
    endpoint: process.env.VISION_ENDPOINT?.trim() || null,
  }),
}));

const logger = pino({ enabled: false });
const debug = vi.spyOn(logger, 'debug');
const warn = vi.spyOn(logger, 'warn');
const fetchMock = vi.fn<typeof fetch>();
const raster = {
  png: Buffer.from('private-image'),
  width: 300,
  height: 100,
  originNodeIds: ['ink-1', 'ink-2'],
};
const params = { raster, logger };

function response(lines: unknown[] = [{ text: '手写问题' }]): Response {
  return Response.json({ readResult: { blocks: [{ lines }] } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lastOutcome() {
  const calls = [...debug.mock.calls, ...warn.mock.calls];
  expect(calls).toHaveLength(1);
  return calls[0]?.[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VISION_KEY', 'private-key');
  vi.stubEnv(
    'VISION_ENDPOINT',
    'https://private-resource.cognitiveservices.azure.com/',
  );
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ink OCR configuration', () => {
  it('reads configuration lazily and disables when both values are absent', async () => {
    expect(isInkOcrConfigured()).toBe(true);
    vi.stubEnv('VISION_KEY', '');
    vi.stubEnv('VISION_ENDPOINT', '');
    expect(isInkOcrConfigured()).toBe(false);
    expect(await recognizeInk(params)).toBeUndefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'https://private-resource.cognitiveservices.azure.com/'],
    ['private-key', ''],
    ['private-key', 'not-a-url'],
    ['private-key', 'http://private-resource.example/'],
    ['private-key', 'https://user:pass@private-resource.example/'],
    ['private-key', 'https://private-resource.example/?secret=value'],
    ['private-key', 'https://private-resource.example/#fragment'],
    ['private-key', 'https://gateway.example/'],
    ['private-key', 'https://127.0.0.1/'],
    ['private-key', 'https://private-resource.cognitiveservices.azure.cn/'],
    [
      'private-key',
      'https://private-resource.cognitiveservices.azure.com:8443/',
    ],
    [
      'private-key',
      'https://private-resource.cognitiveservices.azure.com/path',
    ],
    [
      'private-key',
      'https://private-resource.cognitiveservices.azure.com.evil.example/',
    ],
  ])('rejects unsafe or partial configuration (%#)', async (key, endpoint) => {
    vi.stubEnv('VISION_KEY', key);
    vi.stubEnv('VISION_ENDPOINT', endpoint);
    expect(isInkOcrConfigured(logger)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { outcome: 'config_error' },
      expect.any(String),
    );
    vi.clearAllMocks();
    expect(await recognizeInk(params)).toBeUndefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'config_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Ink OCR response validation', () => {
  it('posts to a public regional endpoint with the default HTTPS port', async () => {
    vi.stubEnv(
      'VISION_ENDPOINT',
      'https://eastus.api.cognitive.microsoft.com:443',
    );
    fetchMock.mockResolvedValue(response());
    expect(await recognizeInk(params)).toBeDefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://eastus.api.cognitive.microsoft.com/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read',
    );
  });

  it('posts the PNG once and preserves ordered lines and confidence', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        readResult: {
          blocks: [
            {
              lines: [
                {
                  text: ' 手写问题 ',
                  words: [{ confidence: 0.1 }, {}, { confidence: 0.3 }],
                },
                { text: '第二行' },
              ],
            },
          ],
        },
      }),
    );

    expect(await recognizeInk(params)).toEqual({
      provider: 'azure-vision',
      apiVersion: '2024-02-01',
      originNodeIds: raster.originNodeIds,
      lines: [{ text: '手写问题', confidence: 0.2 }, { text: '第二行' }],
    });
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://private-resource.cognitiveservices.azure.com/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read',
    );
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': 'private-key',
      },
      body: new Uint8Array(raster.png),
    });
    expect(lastOutcome()).toMatchObject({
      outcome: 'success',
      width: 300,
      height: 100,
      nodeCount: 2,
      lineCount: 2,
      slow: false,
      status: 200,
    });
  });

  it.each([[], [{ text: ' \n ' }]].map((lines) => ({ lines })))(
    'falls back for no recognized text (%#)',
    async ({ lines }) => {
      fetchMock.mockResolvedValue(response(lines));
      expect(await recognizeInk(params)).toBeUndefined();
      expect(lastOutcome()).toMatchObject({ outcome: 'empty' });
    },
  );

  it.each([
    {},
    { readResult: {} },
    { readResult: { blocks: [{}] } },
    { readResult: { blocks: [{ lines: [{ text: 42 }] }] } },
    {
      readResult: {
        blocks: [{ lines: [{ text: 'a', words: [{ confidence: 1.1 }] }] }],
      },
    },
  ])('rejects malformed provider output (%#)', async (value) => {
    fetchMock.mockResolvedValue(Response.json(value));
    expect(await recognizeInk(params)).toBeUndefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'invalid_result' });
  });

  it('counts streamed bytes and cancels the body at the response cap', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    expect(await recognizeInk(params)).toBeUndefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'invalid_result' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('accepts a valid body at exactly the response byte cap', async () => {
    const json = JSON.stringify({
      readResult: { blocks: [{ lines: [{ text: 'exact byte boundary' }] }] },
    });
    fetchMock.mockResolvedValue(new Response(json.padEnd(1024 * 1024, ' ')));
    expect(await recognizeInk(params)).toBeDefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'success' });
  });

  it.each([
    () => new Response('{invalid-json'),
    () => new Response(null),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('{}', { headers: { 'content-length': '1048577' } }),
  ])('rejects invalid or oversized bodies (%#)', async (makeResponse) => {
    fetchMock.mockResolvedValue(makeResponse());
    expect(await recognizeInk(params)).toBeUndefined();
    expect(lastOutcome()).toMatchObject({ outcome: 'invalid_result' });
  });

  it('does not read remote error bodies or retry', async () => {
    const remote = new Response('private remote body', { status: 429 });
    if (!remote.body) throw new Error('Expected a response body');
    const getReader = vi.spyOn(remote.body, 'getReader');
    fetchMock.mockResolvedValue(remote);
    expect(await recognizeInk(params)).toBeUndefined();
    expect(getReader).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lastOutcome()).toMatchObject({
      outcome: 'remote_error',
      status: 429,
    });
  });

  it('redacts provider payloads and configuration from logs', async () => {
    fetchMock.mockRejectedValue(
      new Error('private-key private-resource.example private-image'),
    );
    expect(await recognizeInk(params)).toBeUndefined();
    fetchMock.mockResolvedValue(response([{ text: 'private-transcription' }]));
    await recognizeInk(params);
    const logs = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
    for (const value of [
      'private-key',
      'private-resource.example',
      'private-image',
      'private-transcription',
    ]) {
      expect(logs).not.toContain(value);
    }
  });
});

describe('Ink OCR deadline and cancellation', () => {
  it.each([
    { durationMs: 1499, slow: false },
    { durationMs: 1500, slow: true },
    { durationMs: 1999, slow: true },
  ])(
    'uses 1500ms only for telemetry, allowing success at $durationMs ms',
    async ({ durationMs, slow }) => {
      const pending = deferred<Response>();
      fetchMock.mockReturnValue(pending.promise);
      const result = recognizeInk(params);
      await vi.advanceTimersByTimeAsync(durationMs);
      pending.resolve(response());
      expect(await result).toBeDefined();
      expect(lastOutcome()).toMatchObject({
        outcome: 'success',
        durationMs,
        slow,
      });
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'settles at exactly 2000ms and discards a late %s',
    async (completion) => {
      const pending = deferred<Response>();
      fetchMock.mockReturnValue(pending.promise);
      const result = recognizeInk(params);
      await vi.advanceTimersByTimeAsync(1999);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeUndefined();
      expect(lastOutcome()).toMatchObject({
        outcome: 'timeout',
        durationMs: 2000,
      });
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (completion === 'resolve') pending.resolve(response());
      else pending.reject(new Error('late-private-error'));
      await vi.advanceTimersByTimeAsync(100);
      expect(lastOutcome()).toMatchObject({ outcome: 'timeout' });
    },
  );

  it('does not fetch a pre-aborted turn', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await recognizeInk({ ...params, signal: controller.signal }),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastOutcome()).toMatchObject({ outcome: 'aborted' });
  });

  it('settles Stop during fetch and cleans up the deadline', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const result = recognizeInk({ ...params, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await result).toBeUndefined();
    expect(lastOutcome()).toMatchObject({
      outcome: 'aborted',
      durationMs: 10,
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(response());
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastOutcome()).toMatchObject({ outcome: 'aborted' });
  });

  it('applies the same deadline while reading a noncooperative body', async () => {
    const body = new ReadableStream<Uint8Array>();
    const remote = new Response(body);
    const reader = body.getReader();
    const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    vi.spyOn(reader, 'read').mockReturnValue(pendingRead.promise);
    const cancel = vi
      .spyOn(reader, 'cancel')
      .mockReturnValue(new Promise(() => {}));
    vi.spyOn(body, 'getReader').mockReturnValue(reader);
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return remote;
    });

    const result = recognizeInk(params);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBeUndefined();
    expect(lastOutcome()).toMatchObject({
      outcome: 'timeout',
      durationMs: 2000,
    });
    expect(cancel).toHaveBeenCalled();
    pendingRead.resolve({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(false);
  });
});
