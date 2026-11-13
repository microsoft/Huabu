// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { contentWatermark, recordContentSave } from './content-watermark.js';
import syncRoutes from './sync.route.js';

import type { CanvasSyncEvent } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('../storage/index.js', () => ({ space: () => ({ read: mocks.read }) }));
vi.mock('./canvas-sync.js', () => ({
  subscribeCanvasUpdates: mocks.subscribe,
}));
afterEach(() => vi.resetAllMocks());

it.each(['close', 'failure', 'snapshot'] as const)(
  'cleans up or buffers notifications correctly during baseline %s',
  async (outcome) => {
    let resolve!: (value: { version: number }) => void;
    let reject!: (error: Error) => void;
    mocks.read.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    let receive!: (event: CanvasSyncEvent) => void;
    mocks.subscribe.mockImplementation((_id, listener) => {
      receive = listener;
      return mocks.unsubscribe;
    });
    const app = Fastify();
    await app.register(syncRoutes);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/child/sync/stream`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (outcome === 'close') {
        controller.abort();
        await vi.waitFor(() =>
          expect(mocks.unsubscribe).toHaveBeenCalledOnce(),
        );
        resolve({ version: 1 });
      } else if (outcome === 'failure') {
        reject(new Error('Storage unavailable'));
        await vi.waitFor(() =>
          expect(mocks.unsubscribe).toHaveBeenCalledOnce(),
        );
      } else {
        receive({ type: 'invalidate', data: { nodeIds: ['agent'] } });
        resolve({ version: 1 });
        let body = '';
        while (!body.includes('event: invalidate')) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done)
            throw new Error('Stream ended before invalidation');
          body += new TextDecoder().decode(chunk.value);
        }
        expect(body.indexOf('event: snapshot')).toBeLessThan(
          body.indexOf('event: invalidate'),
        );
      }
    } finally {
      controller.abort();
      resolve({ version: 1 });
      await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledOnce());
      await app.close();
    }
  },
);

it('sends the Space version and nothing else in the snapshot', async () => {
  mocks.read.mockResolvedValue({ version: 7 });
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  const app = Fastify();
  await app.register(syncRoutes);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/child/sync/stream`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    let body = '';
    while (!/event: snapshot\ndata: .*\n\n/.test(body)) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) throw new Error('Stream ended early');
      body += new TextDecoder().decode(chunk.value);
    }
    expect(
      JSON.parse(/event: snapshot\ndata: (.*)\n/.exec(body)?.[1] ?? ''),
    ).toEqual({ version: 7 });
  } finally {
    controller.abort();
    await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledOnce());
    await app.close();
  }
});

/** The answer of `GET /child/content/changes` asked from `since`. */
async function changesSince(since: { epoch: string; seq: number }) {
  mocks.read.mockResolvedValue({ version: 7 });
  const app = Fastify();
  await app.register(syncRoutes);
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/child/content/changes?epoch=${encodeURIComponent(since.epoch)}&seq=${since.seq}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

it('names the nodes whose content was saved since the position a page gives', async () => {
  const seen = contentWatermark();
  recordContentSave('child', ['n1']);
  recordContentSave('other-space', ['elsewhere']);
  recordContentSave('child', ['n2']);
  expect(await changesSince(seen)).toEqual({
    position: contentWatermark(),
    changedNodeIds: ['n1', 'n2'],
  });
});

it('names nothing when nothing was saved since', async () => {
  const seen = contentWatermark();
  expect(await changesSince(seen)).toEqual({ position: contentWatermark() });
});

it('says so when it cannot tell what was saved since', async () => {
  const seen = contentWatermark();
  expect(
    await changesSince({ epoch: 'before-restart', seq: seen.seq }),
  ).toEqual({ position: contentWatermark(), reset: true });
});

it('refuses a content position that is not one, and a Space that does not exist', async () => {
  const app = Fastify();
  await app.register(syncRoutes);
  try {
    mocks.read.mockResolvedValue({ version: 7 });
    for (const query of ['', '?epoch=e', '?epoch=e&seq=-1', '?epoch=e&seq=x'])
      expect(
        (await app.inject({ url: `/child/content/changes${query}` }))
          .statusCode,
      ).toBe(400);
    mocks.read.mockResolvedValue(null);
    expect(
      (await app.inject({ url: '/child/content/changes?epoch=e&seq=0' }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
