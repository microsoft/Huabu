// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  registry: null as {
    profiles: unknown[];
    listProfiles: () => unknown[];
    createProfile: (input: Record<string, unknown>) => unknown;
  } | null,
}));

vi.mock('@agenetes/agentlet-host', () => {
  class AgentletRequestError extends Error {
    readonly rpcCode: number;
    readonly data?: unknown;

    constructor(error: { code: number; message: string; data?: unknown }) {
      super(error.message);
      this.rpcCode = error.code;
      this.data = error.data;
    }
  }
  return {
    AgentletRequestError,
    getAgentTeamRegistry: () => host.registry,
    getAgentletGateway: () => null,
  };
});

import { AcpMachineDiscoveryService } from './machine-discovery.js';

type DiscoveryResult = {
  harnesses: Array<
    | {
        harnessId: string;
        status: 'installed';
        executablePath: string;
        version?: string;
      }
    | { harnessId: string; status: 'missing' }
  >;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createGateway(options?: {
  capabilities?: {
    version: 1;
    harnessDiscovery?: boolean;
    nativePathValidation?: boolean;
  };
}) {
  const handlers = new Set<() => void>();
  const connection = {
    agentletId: 'machine-1',
    status: 'connected',
    connectedAt: new Date('2026-09-16T10:00:00.000Z'),
    agentletProfile: {
      machine: { hostname: 'devbox', platform: 'linux' },
      capabilities: {
        autoRestart: true,
        bufferLimit: 100,
        control: options?.capabilities ?? {
          version: 1,
          harnessDiscovery: true,
          nativePathValidation: true,
        },
      },
    },
  };
  const gateway = {
    connection,
    getAgentlet: vi.fn((id: string) =>
      id === connection.agentletId ? connection : undefined,
    ),
    getAgentlets: vi.fn((filter?: { status?: string }) =>
      !filter?.status || filter.status === connection.status
        ? [connection]
        : [],
    ),
    onAgentTeamMachinesChanged: vi.fn((handler: () => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    discoverHarnesses: vi.fn<() => Promise<DiscoveryResult>>(async () => ({
      harnesses: [
        {
          harnessId: 'copilot',
          status: 'installed',
          executablePath: '/usr/bin/copilot',
          version: '1.2.3',
        },
      ],
    })),
    validateNativePath: vi.fn<
      (
        id: string,
        params?: { cwd?: string },
      ) => Promise<{ cwd: string; source: 'default' | 'explicit' }>
    >(async (_id: string, params?: { cwd?: string }) => ({
      cwd: params?.cwd ?? '/home/user',
      source: params?.cwd ? 'explicit' : 'default',
    })),
    notify: () => {
      for (const handler of handlers) handler();
    },
  };
  return gateway;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  host.registry = null;
});

describe('AcpMachineDiscoveryService', () => {
  it('projects current machines without probing from a GET-equivalent list', () => {
    const gateway = createGateway();
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    const response = service.list();

    expect(response.machines).toHaveLength(1);
    expect(response.machines[0]).toMatchObject({
      agentletId: 'machine-1',
      connected: true,
      discovery: 'refreshing',
    });
    expect(response.machines[0]?.agents).toHaveLength(10);
    expect(gateway.discoverHarnesses).not.toHaveBeenCalled();
    expect(gateway.validateNativePath).not.toHaveBeenCalled();
  });

  it('refreshes after connection and reconnection while ignoring stale completion', async () => {
    const gateway = createGateway();
    const first = deferred<{
      harnesses: Array<{
        harnessId: string;
        status: 'installed';
        executablePath: string;
      }>;
    }>();
    gateway.discoverHarnesses
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        harnesses: [{ harnessId: 'copilot', status: 'missing' }],
      });
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    service.attach(gateway as never);
    gateway.notify();
    await settle();
    expect(gateway.discoverHarnesses).toHaveBeenCalledTimes(2);
    expect(service.list().machines[0]).toMatchObject({
      discovery: 'ready',
      agents: expect.arrayContaining([
        expect.objectContaining({ harnessId: 'copilot', status: 'missing' }),
      ]),
    });

    first.resolve({
      harnesses: [
        {
          harnessId: 'copilot',
          status: 'installed',
          executablePath: '/old/copilot',
        },
      ],
    });
    await settle();
    expect(service.list().machines[0]?.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ harnessId: 'copilot', status: 'missing' }),
      ]),
    );
  });

  it('deduplicates concurrent manual refreshes', async () => {
    const gateway = createGateway();
    const observation = deferred<{
      harnesses: Array<{ harnessId: string; status: 'missing' }>;
    }>();
    gateway.discoverHarnesses.mockImplementation(() => observation.promise);
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    const first = service.refresh('machine-1');
    const second = service.refresh('machine-1');
    expect(gateway.discoverHarnesses).toHaveBeenCalledOnce();
    observation.resolve({
      harnesses: [{ harnessId: 'copilot', status: 'missing' }],
    });
    await Promise.all([first, second]);
    expect(gateway.discoverHarnesses).toHaveBeenCalledOnce();
  });

  it('reports older daemons as unsupported without invoking discovery', async () => {
    const gateway = createGateway({
      capabilities: { version: 1, nativePathValidation: true },
    });
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    await service.refresh('machine-1');

    expect(service.list().machines[0]).toMatchObject({
      discovery: 'unsupported',
      error: { code: 'unsupported_capability' },
    });
    expect(gateway.discoverHarnesses).not.toHaveBeenCalled();
  });

  it('preserves observations while marking a disconnected machine offline', async () => {
    const gateway = createGateway();
    const service = new AcpMachineDiscoveryService(() => gateway as never);
    await service.refresh('machine-1');

    gateway.connection.status = 'disconnected';
    gateway.notify();

    expect(service.list().machines[0]).toMatchObject({
      connected: false,
      discovery: 'ready',
      agents: expect.arrayContaining([
        expect.objectContaining({ harnessId: 'copilot', status: 'installed' }),
      ]),
    });
  });

  it('clears a stale default cwd when the target no longer reports one', async () => {
    const gateway = createGateway();
    const service = new AcpMachineDiscoveryService(() => gateway as never);
    await service.refresh('machine-1');
    expect(service.list().machines[0]?.defaultWorkingDirPath).toBe(
      '/home/user',
    );

    gateway.validateNativePath.mockRejectedValue(
      new Error('home directory unavailable'),
    );
    await service.refresh('machine-1');

    expect(service.list().machines[0]?.defaultWorkingDirPath).toBeUndefined();
  });

  it('materializes with the target default cwd, reuses exact provenance, and recreates after deletion', async () => {
    const gateway = createGateway();
    const profiles: Array<Record<string, unknown>> = [];
    let nextId = 1;
    const createProfile = vi.fn((input: Record<string, unknown>) => {
      const profile = {
        id: `profile-${nextId++}`,
        alias: input.alias,
        agentletId: input.agentletId,
        workingDirPath: input.workingDirPath,
        launch: { kind: 'acp-command', command: input.command },
        metadata: input.metadata,
        customData: input.customData,
      };
      profiles.push(profile);
      return profile;
    });
    host.registry = {
      profiles,
      listProfiles: () => profiles,
      createProfile,
    };
    const service = new AcpMachineDiscoveryService(() => gateway as never);
    await service.refresh('machine-1');

    const first = await service.materialize('machine-1', 'copilot');
    const reused = await service.materialize('machine-1', 'copilot');
    profiles.splice(0, 1);
    const recreated = await service.materialize('machine-1', 'copilot');

    expect(gateway.validateNativePath).toHaveBeenCalledWith('machine-1', {});
    expect(first).toMatchObject({
      id: 'profile-1',
      workingDirPath: '/home/user',
      launch: { command: 'copilot --acp' },
      metadata: { cliId: 'copilot' },
      customData: {
        discoveredAgent: {
          version: 1,
          agentletId: 'machine-1',
          harnessId: 'copilot',
        },
      },
    });
    expect(reused.id).toBe(first.id);
    expect(recreated.id).toBe('profile-2');
    expect(createProfile).toHaveBeenCalledTimes(2);
  });

  it('keeps duplicate machine identities distinct', async () => {
    const gateway = createGateway();
    const second = {
      ...gateway.connection,
      agentletId: 'machine-2',
      agentletProfile: {
        ...gateway.connection.agentletProfile,
        machine: { hostname: 'devbox', platform: 'linux' },
      },
    };
    gateway.getAgentlet.mockImplementation((id: string) =>
      id === 'machine-1'
        ? gateway.connection
        : id === 'machine-2'
          ? second
          : undefined,
    );
    gateway.getAgentlets.mockImplementation((filter?: { status?: string }) =>
      !filter?.status || filter.status === 'connected'
        ? [gateway.connection, second]
        : [],
    );
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    expect(service.list().machines.map(({ agentletId }) => agentletId)).toEqual(
      ['machine-1', 'machine-2'],
    );
  });

  it('returns classified target-native path errors', async () => {
    const { AgentletRequestError } = await import('@agenetes/agentlet-host');
    const gateway = createGateway();
    gateway.validateNativePath.mockRejectedValue(
      new AgentletRequestError({
        code: -32602,
        message: 'cwd does not exist',
        data: { code: 'path_not_found' },
      }),
    );
    const service = new AcpMachineDiscoveryService(() => gateway as never);

    await expect(
      service.validateWorkingDirectory('machine-1', '/missing'),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'path_not_found',
        status: 400,
      }),
    );
  });
});
