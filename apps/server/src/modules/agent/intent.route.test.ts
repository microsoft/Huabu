// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  logIntentEpisode: vi.fn(),
  recognizeIntent: vi.fn(),
  recognizeIntentStream: vi.fn(),
  recognizeSketchCommands: vi.fn(),
}));

vi.mock('./intent.service.js', () => ({
  logIntentEpisode: serviceMocks.logIntentEpisode,
  recognizeIntent: serviceMocks.recognizeIntent,
  recognizeIntentStream: serviceMocks.recognizeIntentStream,
}));

vi.mock('./sketch.service.js', () => ({
  recognizeSketchCommands: serviceMocks.recognizeSketchCommands,
}));

import intentRoutes from './intent.route.js';

async function buildApp() {
  const app = fastify();
  await app.register(intentRoutes, { prefix: '/intent' });
  await app.ready();
  return app;
}

beforeEach(() => {
  serviceMocks.logIntentEpisode.mockReset().mockResolvedValue(undefined);
  serviceMocks.recognizeIntent.mockReset();
  serviceMocks.recognizeIntentStream.mockReset();
  serviceMocks.recognizeSketchCommands.mockReset();
});

describe('POST /intent/episode', () => {
  it('acknowledges only after the intent episode has persisted', async () => {
    let releaseWrite!: () => void;
    serviceMocks.logIntentEpisode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    const app = await buildApp();
    try {
      let acknowledged = false;
      const responsePromise = app
        .inject({
          method: 'POST',
          url: '/intent/episode',
          payload: {
            canvasId: 'canvas-a',
            episode: {
              id: 'episode-a',
              timestamp: 1,
              contextSummary: 'one note selected',
              candidates: [{ label: 'Summarize it' }],
              outcome: { type: 'dismissed' },
            },
          },
        })
        .then((response) => {
          acknowledged = true;
          return response;
        });

      await vi.waitFor(() => {
        expect(serviceMocks.logIntentEpisode).toHaveBeenCalledTimes(1);
      });
      expect(acknowledged).toBe(false);

      releaseWrite();
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
    } finally {
      await app.close();
    }
  });
});
