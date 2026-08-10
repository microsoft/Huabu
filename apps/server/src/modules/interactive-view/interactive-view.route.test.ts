// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import interactiveViewRoutes from './interactive-view.route.js';
import {
  InteractiveViewServiceError,
  interactiveViewService,
} from './interactive-view.service.js';

async function buildApp() {
  const app = fastify();
  await app.register(interactiveViewRoutes, { prefix: '/interactive-views' });
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Interactive View action route', () => {
  it('accepts a validated action for asynchronous Agent delivery', async () => {
    const submit = vi
      .spyOn(interactiveViewService, 'submitAgentEvent')
      .mockResolvedValue(undefined);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/interactive-views/canvas-a/node-view/actions/approve-plan',
        payload: { input: { approved: true } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true });
      expect(submit).toHaveBeenCalledWith(
        'canvas-a',
        'node-view',
        'approve-plan',
        { approved: true },
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });

  it('maps the shared turn-lease timeout to thread_busy', async () => {
    vi.spyOn(interactiveViewService, 'submitAgentEvent').mockRejectedValue(
      new InteractiveViewServiceError('thread_busy', 'Agent thread is busy'),
    );
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/interactive-views/canvas-a/node-view/actions/approve-plan',
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'thread_busy',
        message: 'Agent thread is busy',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects oversized action input before dispatch', async () => {
    const submit = vi.spyOn(interactiveViewService, 'submitAgentEvent');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/interactive-views/canvas-a/node-view/actions/approve-plan',
        payload: { input: 'x'.repeat(65_537) },
      });

      expect(response.statusCode).toBe(400);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
