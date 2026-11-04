// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './_client';
import {
  listAcpAgentClis,
  loadAcpProfileCapabilities,
  respondAcpPermission,
  updateAcpProfile,
} from './acp';

afterEach(() => vi.unstubAllGlobals());

it('answers permissions in the owning Space and encodes both identities', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ resolved: true }));
  vi.stubGlobal('fetch', fetch);
  const decision = { requestId: 'pending', optionId: 'allow' };
  expect(await respondAcpPermission('thread/#1', decision, 'space/#2')).toEqual(
    { resolved: true },
  );
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(
      /\/acp\/threads\/thread%2F%231\/permission\?canvasId=space%2F%232$/,
    ),
    expect.objectContaining({ method: 'POST', body: JSON.stringify(decision) }),
  );
});

describe('ACP Profile editing API', () => {
  it('reuses a Profile capability cache without a POST', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"source":"profile"}'));
    vi.stubGlobal('fetch', fetch);
    expect(await loadAcpProfileCapabilities('profile/#1')).toEqual({
      source: 'profile',
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/\/acp\/profiles\/profile%2F%231\/capabilities$/),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('automatically discovers capabilities on a cache miss, without any thread identity', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"source":"none"}'))
      .mockResolvedValueOnce(new Response('{"source":"profile"}'));
    vi.stubGlobal('fetch', fetch);
    expect(await loadAcpProfileCapabilities('profile')).toEqual({
      source: 'profile',
    });
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /\/acp\/profiles\/profile\/capabilities\/discover$/,
      ),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch.mock.calls[1][1].body).toBeUndefined();
  });

  it('surfaces discovery failure rather than returning an empty list', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"source":"none"}'))
      .mockResolvedValueOnce(
        new Response('{"message":"Login required"}', { status: 503 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(loadAcpProfileCapabilities('profile')).rejects.toThrow(
      'Login required',
    );
  });
  it('routes discovery to the saved Profile and encodes its identity', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"agents":[]}'));
    vi.stubGlobal('fetch', fetch);
    await listAcpAgentClis({ profileId: 'remote/#1' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/agent-cli\?profileId=remote%2F%231$/),
      expect.any(Object),
    );
  });

  it('routes creation discovery to the selected Agentlet', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"agents":[]}'));
    vi.stubGlobal('fetch', fetch);
    await listAcpAgentClis({ agentletId: 'device/#1' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/agent-cli\?agentletId=device%2F%231$/),
      expect.any(Object),
    );
  });

  it('sends expectedRevision and only explicit patch fields', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const body = { expectedRevision: 3, workingDirPath: '/new' };
    await updateAcpProfile('profile/#1', body);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/profiles\/profile%2F%231$/),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(body) }),
    );
  });

  it('preserves conflict status for reload messaging rather than retrying', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Profile changed',
          code: 'profile_revision_conflict',
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = updateAcpProfile('profile', {
      expectedRevision: 0,
      alias: 'Name',
    });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
