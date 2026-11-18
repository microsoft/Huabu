// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAcpRuntimeLaunch } from '@agenetes/acp-driver';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  port: 3001,
  platform: 'linux',
  credentials: vi.fn(async (_spec: unknown) => ({
    HUABU_RFS_TOKEN: 'synthetic-current-token',
  })),
}));
vi.mock('../../../host-port.js', () => ({
  getHostServerPort: () => runtime.port,
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentletGateway: () => ({
    getAgentlet: () => ({
      agentletProfile: { machine: { platform: runtime.platform } },
    }),
  }),
}));
vi.mock('../../identity/agent-credentials.js', () => ({
  agentReachbackEnvironment: runtime.credentials,
  requireOwnAgentlet: vi.fn(),
}));

import {
  buildReachbackEnv,
  resolveReachbackRuntimeEnvironment,
} from './reachback-env.js';
import { openWorkspaceScope, runInWorkspace } from '../../workspace/context.js';

afterEach(() => {
  delete process.env.HUABU_PUBLIC_ORIGIN;
  runtime.port = 3001;
  runtime.platform = 'linux';
  runtime.credentials.mockClear();
});

describe('buildReachbackEnv', () => {
  it('uses the configured canonical public origin', () => {
    process.env.HUABU_PUBLIC_ORIGIN = 'https://huabu.example.com:8443/';

    expect(buildReachbackEnv('thread-1', 'canvas-1')).toEqual({
      HUABU_RFS_URL: 'https://huabu.example.com:8443/api/rfs/canvas-1',
      HUABU_THREAD_ID: 'thread-1',
    });
  });
});

describe('runtime reachback ownership', () => {
  const context = {
    namespace: { name: 'imported-space', ownerId: 'target-workspace' },
    threadId: 'imported-thread',
    agentletId: 'actual-device',
  };
  const spec = {
    binding: { alias: 'Frozen Agent', profileId: 'frozen-profile' },
    agentletId: 'frozen-device-intent',
    cwd: '/frozen/work',
    env: {
      HUABU_RFS_URL: 'https://old.example/api/rfs/w/old/source',
      HUABU_THREAD_ID: 'source-thread',
      HUABU_RFS_TOKEN: 'synthetic-old-token',
      HUABU_RFS_ENTRY: '/old-device/rfs.js',
      HUABU_SERVICE_SDK_URL: 'file:///old-device/sdk.js',
      AGENTLET_SERVER: 'wss://old.example/gateway',
      AGENTLET_TOKEN: 'synthetic-old-daemon-token',
      HUABU_CUSTOM: 'user-value',
      CUSTOM: 'unchanged',
    },
  };
  const policy = {
    getIdleTimeoutSecs: () => 600,
    resolveRuntimeEnvironment: resolveReachbackRuntimeEnvironment,
  };
  const inOwner = <T>(fn: () => T) =>
    runInWorkspace(
      {
        handle: { workspaceId: 'target-workspace', name: 'Target' },
        path: null,
      },
      fn,
    );

  it('refuses ambiguous managed casing when the execution platform is unavailable', async () => {
    runtime.platform = '';
    await expect(
      inOwner(() =>
        resolveAcpRuntimeLaunch(
          {
            ...spec,
            env: { huabu_rfs_entry: '/obsolete-device/rfs.js' },
          },
          policy,
          context,
        ),
      ),
    ).rejects.toThrow('Target Agentlet platform is unavailable');
  });

  it('rebuilds imported coordinates and credentials on every launch without changing frozen intent', async () => {
    const saved = structuredClone(spec);
    for (const origin of [
      'https://first.example',
      'https://restarted.example',
    ]) {
      process.env.HUABU_PUBLIC_ORIGIN = origin;
      const { env } = await inOwner(() =>
        resolveAcpRuntimeLaunch(spec, policy, context),
      );
      expect(env).toEqual({
        HUABU_RFS_URL: `${origin}/api/rfs/w/target-workspace/imported-space`,
        HUABU_THREAD_ID: 'imported-thread',
        HUABU_RFS_TOKEN: 'synthetic-current-token',
        HUABU_CUSTOM: 'user-value',
        CUSTOM: 'unchanged',
      });
      expect(runtime.credentials).toHaveBeenLastCalledWith({
        agentletId: 'actual-device',
        env: {
          HUABU_RFS_URL: `${origin}/api/rfs/w/target-workspace/imported-space`,
          HUABU_THREAD_ID: 'imported-thread',
        },
      });
    }
    expect(spec).toEqual(saved);
  });

  it('recovers legacy records without env and does not invent a scope for unscoped jobs', async () => {
    const { env: _old, ...legacy } = spec;
    const scoped = await inOwner(() =>
      resolveAcpRuntimeLaunch(legacy, policy, context),
    );
    expect(scoped.env).toMatchObject({ HUABU_THREAD_ID: 'imported-thread' });
    const unscoped = await resolveAcpRuntimeLaunch(spec, policy, {
      ...context,
      namespace: { name: '' },
    });
    expect(unscoped.env).toEqual({
      CUSTOM: 'unchanged',
      HUABU_CUSTOM: 'user-value',
    });
    expect(runtime.credentials).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign or unavailable workspace rather than using ambient ownership', async () => {
    await expect(
      runInWorkspace(
        {
          handle: { workspaceId: 'other-workspace', name: 'Other' },
          path: null,
        },
        () => resolveAcpRuntimeLaunch(spec, policy, context),
      ),
    ).rejects.toThrow('namespace is no longer active');
    await expect(
      openWorkspaceScope(() => resolveAcpRuntimeLaunch(spec, policy, context)),
    ).rejects.toThrow('Workspace is unavailable');
    expect(runtime.credentials).not.toHaveBeenCalled();
  });

  it('fails before credential injection when required endpoint or conversation is missing', async () => {
    runtime.port = 0;
    await expect(
      inOwner(() => resolveAcpRuntimeLaunch(spec, policy, context)),
    ).rejects.toThrow('endpoint is unavailable');
    await expect(
      inOwner(() =>
        resolveAcpRuntimeLaunch(spec, policy, { ...context, threadId: '' }),
      ),
    ).rejects.toThrow('conversation is unavailable');
    expect(runtime.credentials).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'])(
    'uses target %s casing, not the server platform, for old declarations',
    async (platform) => {
      runtime.platform = platform;
      const { env } = await inOwner(() =>
        resolveAcpRuntimeLaunch(
          {
            ...spec,
            env: {
              huabu_rfs_url: 'https://old.example',
              agentlet_server: 'wss://old.example',
            },
          },
          policy,
          context,
        ),
      );
      if (platform === 'win32') {
        expect(env).not.toHaveProperty('huabu_rfs_url');
        expect(env).not.toHaveProperty('agentlet_server');
      } else {
        expect(env).toMatchObject({
          huabu_rfs_url: 'https://old.example',
          agentlet_server: 'wss://old.example',
        });
      }
      expect(env?.HUABU_RFS_URL).toContain(
        '/api/rfs/w/target-workspace/imported-space',
      );
    },
  );
});

describe('buildReachbackEnv local origins', () => {
  it('keeps the loopback fallback for local development', () => {
    expect(buildReachbackEnv('thread-1', 'canvas-1')).toEqual({
      HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/canvas-1',
      HUABU_THREAD_ID: 'thread-1',
    });
  });

  it('encodes the canvas id as one path segment', () => {
    process.env.HUABU_PUBLIC_ORIGIN = 'https://192.0.2.10';

    expect(buildReachbackEnv('thread-1', 'canvas/with space')).toMatchObject({
      HUABU_RFS_URL: 'https://192.0.2.10/api/rfs/canvas%2Fwith%20space',
    });
  });
});
