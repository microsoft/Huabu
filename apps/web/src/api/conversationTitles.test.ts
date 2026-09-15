// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './_client';
import {
  queryConversationTitles,
  setConversationTitle,
} from './conversationTitles';

afterEach(() => vi.unstubAllGlobals());

describe('conversation title API', () => {
  it('sends the shared batch body to the query endpoint', async () => {
    const payload = {
      titles: { thread: { title: 'Topic', source: 'generated' } },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal('fetch', fetch);
    const body = { canvasId: 'canvas', threadIds: ['thread'] };
    expect(await queryConversationTitles(body)).toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/agent\/threads\/titles\/query$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
  });

  it('encodes both title route parameters and uses PUT with the shared body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: 'Mine', source: 'user' })),
      );
    vi.stubGlobal('fetch', fetch);
    await setConversationTitle('canvas?x', 'thread#1', { title: 'Mine' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/threads\/thread%231\/title\?canvasId=canvas%3Fx$/,
      ),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'Mine' }),
      }),
    );
  });

  it('preserves typed 404 errors for pending-draft creation races', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Thread is not durable' }), {
          status: 404,
        }),
      ),
    );
    await expect(
      setConversationTitle('canvas', 'thread', { title: 'Mine' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
