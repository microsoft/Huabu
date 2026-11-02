// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

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
