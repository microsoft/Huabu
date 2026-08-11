// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeEpisode = vi.hoisted(() => vi.fn());

vi.mock('./store/intent-store.js', () => ({
  logIntentEpisode: storeEpisode,
}));

import intentRoutes from './intent.route.js';

import type { IntentEpisode } from '@huabu/shared';

const EPISODE: IntentEpisode = {
  id: 'episode-1',
  timestamp: 1,
  contextSummary: 'selected a note action',
  candidates: [{ label: 'Create note' }],
  outcome: {
    type: 'selected',
    chosenIndex: 0,
    chosenLabel: 'Create note',
  },
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function buildApp() {
  const app = fastify();
  await app.register(intentRoutes, { prefix: '/intent' });
  await app.ready();
  return app;
}

beforeEach(() => {
  storeEpisode.mockReset();
  storeEpisode.mockResolvedValue(undefined);
});

describe('POST /intent/episode', () => {
  it('waits for persistence before acknowledging the episode', async () => {
    const write = deferred();
    storeEpisode.mockReturnValueOnce(write.promise);
    const app = await buildApp();

    try {
      const responsePromise = app.inject({
        method: 'POST',
        url: '/intent/episode',
        payload: { episode: EPISODE, canvasId: 'canvas-1' },
      });
      await vi.waitFor(() => {
        expect(storeEpisode).toHaveBeenCalledWith(EPISODE, 'canvas-1');
      });

      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      write.resolve();
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
    } finally {
      write.resolve();
      await app.close();
    }
  });

  it('preserves the successful no-canvas response', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/intent/episode',
        payload: { episode: EPISODE },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(storeEpisode).toHaveBeenCalledWith(EPISODE, undefined);
    } finally {
      await app.close();
    }
  });

  it('keeps persistence failures on the HTTP error path', async () => {
    storeEpisode.mockRejectedValueOnce(new Error('intent write failed'));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/intent/episode',
        payload: { episode: EPISODE, canvasId: 'canvas-1' },
      });

      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});
