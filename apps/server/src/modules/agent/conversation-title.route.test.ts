// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  conversationTitleSchema,
  queryConversationTitlesResponseSchema,
} from '@huabu/shared';

import { createConversationTitleRoutes } from './conversation-title.route.js';

async function fixture() {
  const service = {
    query: vi.fn(async (_canvas: string, ids: string[]) => ({
      titles: Object.fromEntries(
        ids.map((id) => [id, { title: null, source: null }]),
      ),
    })),
    setUserTitle: vi.fn(
      async (_canvas: string, thread: string, title: string) =>
        thread === 'missing' ? null : { title, source: 'user' as const },
    ),
  };
  const app = Fastify();
  await app.register(createConversationTitleRoutes(service), {
    prefix: '/api/agent',
  });
  return { app, service };
}

describe('conversation title API', () => {
  it('returns null for fresh compose threads and normalizes successful manual titles', async () => {
    const { app, service } = await fixture();
    try {
      const query = await app.inject({
        method: 'POST',
        url: '/api/agent/threads/titles/query',
        payload: { canvasId: 'canvas-a', threadIds: ['new-thread'] },
      });
      expect(query.statusCode).toBe(200);
      expect(
        queryConversationTitlesResponseSchema.safeParse(query.json()).success,
      ).toBe(true);
      expect(query.json()).toEqual({
        titles: { 'new-thread': { title: null, source: null } },
      });
      const update = await app.inject({
        method: 'PUT',
        url: '/api/agent/threads/thread-a/title?canvasId=canvas-a',
        payload: { title: '  Name  ' },
      });
      expect(update.statusCode).toBe(200);
      expect(conversationTitleSchema.safeParse(update.json()).success).toBe(
        true,
      );
      expect(update.json()).toEqual({ title: 'Name', source: 'user' });
      expect(service.setUserTitle).toHaveBeenCalledWith(
        'canvas-a',
        'thread-a',
        'Name',
      );
      const missing = await app.inject({
        method: 'PUT',
        url: '/api/agent/threads/missing/title?canvasId=canvas-a',
        payload: { title: 'Name' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('thread_not_found');
    } finally {
      await app.close();
    }
  });

  it('validates all query/path/body inputs before calling the service', async () => {
    const { app, service } = await fixture();
    try {
      for (const payload of [
        null,
        {},
        { canvasId: '', threadIds: [] },
        { canvasId: '../outside', threadIds: [] },
        { canvasId: 'canvas-a', threadIds: ['a/b'] },
        { canvasId: 'canvas-a', threadIds: Array(101).fill('thread') },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/agent/threads/titles/query',
          payload: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' },
        });
        expect(response.statusCode).toBe(400);
      }
      for (const [url, title] of [
        ['/api/agent/threads/t/title', 'Name'],
        ['/api/agent/threads/t/title?canvasId=..', 'Name'],
        ['/api/agent/threads/a%2Fb/title?canvasId=canvas-a', 'Name'],
        ['/api/agent/threads/t/title?canvasId=canvas-a', ' \n '],
        ['/api/agent/threads/t/title?canvasId=canvas-a', 'x'.repeat(121)],
      ]) {
        const response = await app.inject({
          method: 'PUT',
          url,
          payload: { title },
        });
        expect(response.statusCode).toBe(400);
      }
      expect(service.query).not.toHaveBeenCalled();
      expect(service.setUserTitle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
