// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './_client';
import {
  listAcpAgentClis,
  previewAcpProfileLaunch,
  updateAcpProfile,
} from './acp';

import type { AcpProfileLaunchPreviewBody } from '@huabu/shared';

afterEach(() => vi.unstubAllGlobals());

describe('ACP Profile editing API', () => {
  it('routes discovery to the saved Profile and encodes its identity', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"agents":[]}'));
    vi.stubGlobal('fetch', fetch);
    await listAcpAgentClis('remote/#1');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/agent-cli\?profileId=remote%2F%231$/),
      expect.any(Object),
    );
  });

  it('uses supervised-daemon discovery for creation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"agents":[]}'));
    vi.stubGlobal('fetch', fetch);
    await listAcpAgentClis();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/agent-cli$/),
      expect.any(Object),
    );
  });

  it('posts a typed preview to the daemon route, including the saved target Profile', async () => {
    const plan = {
      kind: 'exec',
      executable: '/bin/agent',
      argv: ['--acp'],
      env: {},
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(plan)));
    vi.stubGlobal('fetch', fetch);
    const body: AcpProfileLaunchPreviewBody = {
      profileId: 'saved',
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: false },
      },
    };
    expect(await previewAcpProfileLaunch(body)).toEqual(plan);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/acp\/profile-launch-preview$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
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
