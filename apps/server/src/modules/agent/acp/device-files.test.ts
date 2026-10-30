// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceFilesService } from './device-files.js';
import deviceFilesRoutes from './device-files.route.js';
import { registerLocalTestIdentity } from '../../../test-support/local-identity.js';

import type { AcpAgentClient } from '@agenetes/acp-driver';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  shutdown: vi.fn(),
  prompt: vi.fn(),
  permission: vi.fn(),
  listener: undefined as
    | undefined
    | ((event: {
        agentletId: string;
        status: 'connected' | 'disconnected';
      }) => void),
  connected: true,
  profiles: [] as Array<Record<string, unknown>>,
}));
vi.mock('@agenetes/acp-driver', () => ({
  ensureAcpSession: mocks.ensure,
  releaseThread: mocks.release,
  acpSessionRegistry: { remove: mocks.remove },
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ listProfiles: () => mocks.profiles }),
  getAgentletGateway: () => ({
    getAgentlet: (id: string) =>
      id === 'device' && mocks.connected ? { status: 'connected' } : undefined,
    onAgentletsChanged: (listener: typeof mocks.listener) => {
      mocks.listener = listener;
      return vi.fn();
    },
  }),
}));

const listing = {
  version: 1,
  operation: 'fs-list',
  ok: true,
  result: { path: '/work', parentPath: '/', entries: [] },
};
const request = {
  agentletId: 'device',
  operation: 'fs-list' as const,
  args: { path: '/work' },
};
let service: DeviceFilesService;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connected = true;
  mocks.profiles = [
    {
      id: 'proxy-profile',
      alias: 'Filesystem Proxy',
      agentletId: 'device',
      visible: false,
      launch: { kind: 'acp-harness', harnessId: 'proxy' },
      workingDirPath: '/neutral',
      customData: {
        discoveredAgent: {
          version: 1,
          agentletId: 'device',
          harnessId: 'proxy',
        },
      },
    },
  ];
  mocks.release.mockResolvedValue(undefined);
  mocks.prompt.mockImplementation(
    async (...args: Parameters<AcpAgentClient['prompt']>) => {
      args[2]({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(listing) },
      });
      return { stopReason: 'end_turn' };
    },
  );
  mocks.ensure.mockResolvedValue({
    sessionId: 'session',
    availableCommands: [{ name: 'fs-list' }, { name: 'fs-read' }],
    client: {
      isClosed: false,
      prompt: mocks.prompt,
      shutdown: mocks.shutdown,
      resolvePermission: mocks.permission,
    },
  });
  service = new DeviceFilesService({ warn: vi.fn(), error: vi.fn() });
});
afterEach(async () => {
  await service.dispose();
  vi.useRealTimers();
});

describe('private filesystem ACP service', () => {
  it('validates owner-only HTTP input and marks successful file responses no-store', async () => {
    const app = Fastify();
    registerLocalTestIdentity(app);
    await app.register(deviceFilesRoutes, { prefix: '/api/acp' });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/acp/files',
            remoteAddress: '203.0.113.5',
            payload: request,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/acp/files',
            payload: { ...request, args: { path: 'relative' } },
          })
        ).statusCode,
      ).toBe(400);
      expect(mocks.ensure).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'POST',
        url: '/api/acp/files',
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        operation: 'fs-list',
        result: listing.result,
      });
    } finally {
      await app.close();
    }
  });
  it('reuses one no-history session with fixed cwd and sends only the command', async () => {
    expect(await service.execute(request)).toEqual({
      operation: 'fs-list',
      result: listing.result,
    });
    await service.execute(request);
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadType: 'Job',
        namespace: { name: '' },
        env: {},
        cwd: '/neutral',
        recipe: expect.objectContaining({
          autoRestart: false,
          launch: { kind: 'acp-harness', harnessId: 'proxy' },
        }),
      }),
    );
    expect(mocks.prompt.mock.calls[0]?.[1]).toEqual([
      { type: 'text', text: '/fs-list {"path":"/work"}' },
    ]);
  });

  it('requires exact connected device and an automatic proxy identity', async () => {
    await expect(
      service.execute({ ...request, agentletId: 'hostname' }),
    ).rejects.toMatchObject({ code: 'files_disconnected' });
    mocks.profiles[0]!.agentletId = 'other-device';
    await expect(service.execute(request)).rejects.toMatchObject({
      code: 'files_proxy_missing',
    });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('serializes overlapping calls and denies unexpected permissions', async () => {
    let active = 0;
    mocks.prompt.mockImplementation(
      async (...args: Parameters<AcpAgentClient['prompt']>) => {
        expect(++active).toBe(1);
        args[4]?.({ requestId: 'unexpected', options: [], toolCall: {} });
        await new Promise((resolve) => setImmediate(resolve));
        args[2]({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(listing) },
        });
        active--;
        return { stopReason: 'end_turn' };
      },
    );
    await Promise.all([service.execute(request), service.execute(request)]);
    expect(mocks.permission).toHaveBeenCalledWith('unexpected', {
      cancelled: true,
    });
  });

  it('rejects late replies after connection generation changes', async () => {
    let finish!: () => void;
    mocks.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ stopReason: 'end_turn' });
        }),
    );
    const pending = service.execute(request);
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledOnce());
    mocks.listener?.({ agentletId: 'device', status: 'disconnected' });
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'files_disconnected' });
    expect(mocks.shutdown).toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });

  it.each([
    'prose',
    JSON.stringify({ ...listing, version: 2 }),
    JSON.stringify({ ...listing, operation: 'fs-read' }),
  ])('rejects malformed or mismatched output %s', async (text) => {
    mocks.prompt.mockImplementation(
      async (...args: Parameters<AcpAgentClient['prompt']>) => {
        args[2]({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        });
        return { stopReason: 'end_turn' };
      },
    );
    await expect(service.execute(request)).rejects.toMatchObject({
      status: 502,
    });
  });
  it('does not interpret end_turn as filesystem success', async () => {
    mocks.prompt.mockImplementation(
      async (...args: Parameters<AcpAgentClient['prompt']>) => {
        args[2]({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify({
              version: 1,
              operation: 'fs-list',
              ok: false,
              error: {
                code: 'permission_denied',
                message: 'Permission denied',
              },
            }),
          },
        });
        return { stopReason: 'end_turn' };
      },
    );
    await expect(service.execute(request)).rejects.toMatchObject({
      code: 'permission_denied',
      status: 403,
    });
  });

  it('retains admission ownership for timed-out startup and reclaims a late process', async () => {
    vi.useFakeTimers();
    const entry = await mocks.ensure();
    mocks.ensure.mockClear();
    let complete!: (value: typeof entry) => void;
    mocks.ensure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = service.execute(request);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'files_timeout',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    await expect(service.execute(request)).rejects.toMatchObject({
      code: 'files_busy',
    });
    expect(mocks.ensure).toHaveBeenCalledOnce();
    complete(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.shutdown).toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
    await expect(service.execute(request)).resolves.toMatchObject({
      operation: 'fs-list',
    });
  });

  it('surfaces cleanup failure and retries reclamation before admitting another process', async () => {
    await service.execute(request);
    mocks.release.mockRejectedValueOnce(new Error('Device stop failed'));
    mocks.prompt.mockRejectedValueOnce(new Error('Transport lost'));
    await expect(service.execute(request)).rejects.toMatchObject({
      code: 'files_cleanup_failed',
    });
    await expect(service.execute(request)).resolves.toMatchObject({
      operation: 'fs-list',
    });
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });
});
