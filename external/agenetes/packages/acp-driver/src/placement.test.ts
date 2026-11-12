import { AgentletRequestError } from '@agenetes/agentlet-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  gateway: undefined as unknown,
}));

vi.mock('@agenetes/agentlet-host', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentletHostModule>();
  return {
    ...actual,
    getAgentletGateway: () => host.gateway,
    resolveConnectedAgentletId: (target: string) => {
      const gateway = host.gateway as
        | {
            getAgentlet?: (
              agentletId: string,
            ) => { agentletId?: string; status?: string } | undefined;
            getAgentlets?: () => Array<{
              agentletId: string;
              status: string;
              agentletProfile?: { machine?: { hostname?: string } };
            }>;
          }
        | undefined;
      const exact = gateway?.getAgentlet?.(target);
      if (exact?.status === 'connected') return exact.agentletId ?? target;
      const matches = (gateway?.getAgentlets?.() ?? []).filter(
        (connection) =>
          connection.status === 'connected' &&
          connection.agentletProfile?.machine?.hostname === target,
      );
      return matches.length === 1 ? matches[0]?.agentletId : undefined;
    },
  };
});

import { acpSessionRegistry } from './session-registry.js';
import {
  _resetSpawnOrchestratorForTests,
  ensureAgentForThread,
  releaseThread,
} from './spawn-orchestrator.js';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpAgentClient } from './client.js';
import type { AcpSessionEntry } from './session-registry.js';
import type * as AgentletHostModule from '@agenetes/agentlet-host';

const recipe: AcpBindingRecipe = {
  alias: 'test-agent',
  command: 'test-agent --acp',
  autoRestart: false,
};

afterEach(() => {
  _resetSpawnOrchestratorForTests();
  vi.useRealTimers();
});

describe('explicit ACP placement', () => {
  it('routes a hostname-era workload to its unique connected device identity', async () => {
    const sessions = new Map<string, { status: 'connected' }>();
    const spawnOnAgentlet = vi.fn(
      async (agentletId: string, params: { appId: string }) => {
        const sessionId = `${agentletId}-${params.appId}`;
        sessions.set(JSON.stringify([agentletId, sessionId]), {
          status: 'connected',
        });
        return { sessionId, pid: 101 };
      },
    );
    host.gateway = {
      getAgentlet: (agentletId: string) =>
        agentletId === 'device-uuid'
          ? { agentletId, status: 'connected' }
          : undefined,
      getAgentlets: () => [
        {
          agentletId: 'device-uuid',
          status: 'connected',
          agentletProfile: { machine: { hostname: 'legacy-host' } },
        },
      ],
      getSession: (agentletId: string, sessionId: string) =>
        sessions.get(JSON.stringify([agentletId, sessionId])),
      spawnOnAgentlet,
    };

    await expect(
      ensureAgentForThread('legacy-host', 'legacy-thread', recipe),
    ).resolves.toMatchObject({ agentletId: 'device-uuid' });
    expect(spawnOnAgentlet).toHaveBeenCalledWith(
      'device-uuid',
      expect.any(Object),
    );
  });

  it('ignores a persisted structured plan and reuses the live process by frozen launch intent', async () => {
    const launch = {
      kind: 'acp-harness' as const,
      harnessId: 'copilot',
      options: { autoApprove: true },
    };
    const launchPlan = {
      version: 1 as const,
      executable: 'copilot',
      argv: ['--acp', '--allow-all'],
      env: {},
    };
    const spawnOnAgentlet = vi.fn(async () => ({
      sessionId: 'structured-session',
      pid: 404,
      launchPlan,
    }));
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet,
    };
    const structured = {
      alias: 'Typed',
      autoRestart: true,
      launch,
      launchPlan,
    };
    const first = await ensureAgentForThread('machine-a', 'typed', structured);
    expect(spawnOnAgentlet).toHaveBeenCalledWith('machine-a', {
      appId: 'typed',
      workloadType: 'Deployment',
      sessionSpec: {
        launch,
        cwd: undefined,
        autoRestart: true,
        idleTimeoutSecs: 600,
        env: undefined,
      },
    });
    expect(first).not.toHaveProperty('launchPlan');
    expect(
      await ensureAgentForThread('machine-a', 'typed', structured),
    ).toEqual(first);
    expect(spawnOnAgentlet).toHaveBeenCalledTimes(1);
  });

  it('accepts structured spawn responses without a compiled plan', async () => {
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet: vi.fn(async () => ({
        sessionId: 'wrong-daemon',
        pid: 404,
      })),
    };
    await expect(
      ensureAgentForThread('machine-a', 'typed', {
        alias: 'Typed',
        autoRestart: true,
        launch: { kind: 'acp-harness', harnessId: 'copilot' },
      }),
    ).resolves.toMatchObject({ sessionId: 'wrong-daemon', pid: 404 });
  });

  it('classifies redacted capacity diagnostics separately from spawn failures', async () => {
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      spawnOnAgentlet: vi.fn(async () => {
        throw new AgentletRequestError({
          code: -32000,
          message: 'Max agents reached (10)',
          data: {
            code: 'capacity_exhausted',
            limit: 10,
            active: {
              total: 10,
              jobs: 7,
              deployments: 2,
              unknown: 1,
              stopping: 1,
            },
          },
        });
      }),
    };

    await expect(
      ensureAgentForThread('machine-a', 'capacity-thread', recipe),
    ).rejects.toMatchObject({
      code: 'capacity_exhausted',
      message:
        'External agent capacity is exhausted: limit 10; active 10 (7 Jobs, 2 Deployments, 1 unclassified, 1 stopping)',
    });
  });

  it('isolates live session registry entries by placement and thread', () => {
    const entryA = {
      agentletId: 'machine-a',
      threadId: 'thread-1',
      namespace: { name: 'legacy' },
      client: { shutdown: vi.fn() } as unknown as AcpAgentClient,
    } as AcpSessionEntry;
    const entryB = {
      agentletId: 'machine-b',
      threadId: 'thread-1',
      namespace: { name: 'legacy' },
      client: { shutdown: vi.fn() } as unknown as AcpAgentClient,
    } as AcpSessionEntry;

    acpSessionRegistry.set('machine-a', 'thread-1', entryA);
    acpSessionRegistry.set('machine-b', 'thread-1', entryB);

    expect(acpSessionRegistry.get('machine-a', 'thread-1')).toBe(entryA);
    expect(acpSessionRegistry.get('machine-b', 'thread-1')).toBe(entryB);
    acpSessionRegistry.remove('machine-a', 'thread-1');
    expect(acpSessionRegistry.get('machine-b', 'thread-1')).toBe(entryB);
    acpSessionRegistry.remove('machine-b', 'thread-1');
  });

  it('isolates same-thread caches across agentlets', async () => {
    const sessions = new Map<string, { status: 'connected' }>();
    const spawnOnAgentlet = vi.fn(
      async (agentletId: string, params: { appId: string }) => {
        const sessionId = `${agentletId}-${params.appId}`;
        sessions.set(JSON.stringify([agentletId, sessionId]), {
          status: 'connected',
        });
        return { sessionId, pid: agentletId === 'machine-a' ? 101 : 202 };
      },
    );
    host.gateway = {
      getAgentlet: (agentletId: string) =>
        agentletId === 'machine-a' || agentletId === 'machine-b'
          ? { agentletId, status: 'connected' }
          : undefined,
      getSession: (agentletId: string, sessionId: string) =>
        sessions.get(JSON.stringify([agentletId, sessionId])),
      spawnOnAgentlet,
    };

    const firstA = await ensureAgentForThread('machine-a', 'thread-1', recipe);
    const firstB = await ensureAgentForThread('machine-b', 'thread-1', recipe);
    const secondA = await ensureAgentForThread('machine-a', 'thread-1', recipe);

    expect(firstA.sessionId).toBe('machine-a-thread-1');
    expect(firstB.sessionId).toBe('machine-b-thread-1');
    expect(secondA).toEqual(firstA);
    expect(spawnOnAgentlet).toHaveBeenCalledTimes(2);
  });

  it('passes the host idle-timeout policy to agentlet spawn', async () => {
    const spawnOnAgentlet = vi.fn(async () => ({
      sessionId: 'session-never-suspend',
      pid: 303,
    }));
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet,
    };

    await ensureAgentForThread(
      'machine-a',
      'thread-never-suspend',
      recipe,
      undefined,
      undefined,
      0,
    );

    expect(spawnOnAgentlet).toHaveBeenCalledWith(
      'machine-a',
      expect.objectContaining({
        sessionSpec: expect.objectContaining({ idleTimeoutSecs: 0 }),
      }),
    );
  });

  it('reclaims the exact session once and treats repeated release as success', async () => {
    const stopOnAgentlet = vi.fn(async () => ({
      stopped: true,
      disposition: 'stopped' as const,
    }));
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet: vi.fn(async () => ({
        sessionId: 'native-session',
        pid: 303,
      })),
      stopOnAgentlet,
    };
    await ensureAgentForThread(
      'machine-a',
      'job-thread',
      recipe,
      undefined,
      undefined,
      600,
      'Job',
    );

    await Promise.all([
      releaseThread('machine-a', 'job-thread'),
      releaseThread('machine-a', 'job-thread'),
    ]);
    await releaseThread('machine-a', 'job-thread');

    expect(stopOnAgentlet).toHaveBeenCalledOnce();
    expect(stopOnAgentlet).toHaveBeenCalledWith('machine-a', {
      sessionId: 'native-session',
    });
  });

  it('retains ownership after stop failure so cleanup can be retried', async () => {
    const stopOnAgentlet = vi
      .fn()
      .mockRejectedValueOnce(new Error('still running'))
      .mockResolvedValueOnce({
        stopped: true,
        disposition: 'already_absent',
      });
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet: vi.fn(async () => ({
        sessionId: 'retry-session',
        pid: 303,
      })),
      stopOnAgentlet,
    };
    await ensureAgentForThread('machine-a', 'retry-thread', recipe);

    await expect(
      releaseThread('machine-a', 'retry-thread'),
    ).rejects.toMatchObject({ code: 'cleanup_failed' });
    await expect(
      releaseThread('machine-a', 'retry-thread'),
    ).resolves.toBeUndefined();
    expect(stopOnAgentlet).toHaveBeenCalledTimes(2);
  });

  it('returns a structured placement error when the target is absent', async () => {
    vi.useFakeTimers();
    host.gateway = {
      getAgentlet: () => undefined,
    };

    const pending = ensureAgentForThread('machine-missing', 'thread-1', recipe);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'placement_unavailable',
    });
    await vi.advanceTimersByTimeAsync(20_100);

    await rejection;
  });
});

describe('qualified ACP legacy lifecycle access', () => {
  const namespaceA = { name: 'shared-name', ownerId: 'workspace-a' };
  const namespaceB = { name: 'shared-name', ownerId: 'workspace-b' };

  it('retains a spawned process after failed handshake compensation until cleanup succeeds', async () => {
    vi.useFakeTimers();
    const stopOnAgentlet = vi
      .fn()
      .mockRejectedValueOnce(new Error('still running'))
      .mockResolvedValueOnce({ stopped: true, disposition: 'stopped' });
    const spawnOnAgentlet = vi.fn(async () => ({
      sessionId: 'unconnected-native',
      pid: 404,
    }));
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => undefined,
      spawnOnAgentlet,
      stopOnAgentlet,
    };
    const pending = ensureAgentForThread(
      'machine-a',
      'handshake-compensation',
      recipe,
      undefined,
      undefined,
      600,
      'Deployment',
      namespaceA,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'cleanup_failed',
    });
    try {
      await vi.advanceTimersByTimeAsync(3100);
      await rejected;
      await expect(
        ensureAgentForThread(
          'machine-a',
          'handshake-compensation',
          recipe,
          undefined,
          undefined,
          600,
          'Deployment',
          namespaceA,
        ),
      ).rejects.toMatchObject({ code: 'cleanup_failed' });
      expect(spawnOnAgentlet).toHaveBeenCalledTimes(1);
      await releaseThread('machine-a', 'handshake-compensation', namespaceA);
      expect(stopOnAgentlet).toHaveBeenNthCalledWith(2, 'machine-a', {
        sessionId: 'unconnected-native',
      });
    } finally {
      await pending.catch(() => undefined);
      await releaseThread('machine-a', 'handshake-compensation', namespaceA);
    }
  });

  it('refuses unqualified registry lookup and removal when the device/thread is ambiguous', () => {
    const entryA = {
      agentletId: 'machine-a',
      threadId: 'legacy-ambiguous',
      namespace: namespaceA,
      client: { shutdown: vi.fn() },
    } as unknown as AcpSessionEntry;
    const entryB = {
      agentletId: 'machine-a',
      threadId: 'legacy-ambiguous',
      namespace: namespaceB,
      client: { shutdown: vi.fn() },
    } as unknown as AcpSessionEntry;
    acpSessionRegistry.set('machine-a', 'legacy-ambiguous', entryA);
    acpSessionRegistry.set('machine-a', 'legacy-ambiguous', entryB);
    try {
      expect(() =>
        acpSessionRegistry.get('machine-a', 'legacy-ambiguous'),
      ).toThrow('Ambiguous');
      expect(() =>
        acpSessionRegistry.remove('machine-a', 'legacy-ambiguous'),
      ).toThrow('Ambiguous');
      expect(entryA.client.shutdown).not.toHaveBeenCalled();
      expect(entryB.client.shutdown).not.toHaveBeenCalled();
      expect(
        acpSessionRegistry.get('machine-a', 'legacy-ambiguous', namespaceA),
      ).toBe(entryA);
      acpSessionRegistry.remove('machine-a', 'legacy-ambiguous', namespaceA);
      expect(acpSessionRegistry.get('machine-a', 'legacy-ambiguous')).toBe(
        entryB,
      );
    } finally {
      acpSessionRegistry.remove('machine-a', 'legacy-ambiguous', namespaceA);
      acpSessionRegistry.remove('machine-a', 'legacy-ambiguous', namespaceB);
    }
  });

  it('includes a pending peer in legacy lookup/removal/release ambiguity', async () => {
    const entryA = {
      agentletId: 'machine-a',
      threadId: 'legacy-pending',
      namespace: namespaceA,
      client: { shutdown: vi.fn() },
    } as unknown as AcpSessionEntry;
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{
      sessionId: string;
      pid: number;
    }>();
    const stopOnAgentlet = vi.fn(async () => ({
      stopped: true,
      disposition: 'stopped',
    }));
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet: vi.fn(() => {
        started.resolve();
        return response.promise;
      }),
      stopOnAgentlet,
    };
    acpSessionRegistry.set('machine-a', 'legacy-pending', entryA);
    const pending = ensureAgentForThread(
      'machine-a',
      'legacy-pending',
      recipe,
      undefined,
      undefined,
      600,
      'Deployment',
      namespaceB,
    );
    try {
      await started.promise;
      expect(() =>
        acpSessionRegistry.get('machine-a', 'legacy-pending'),
      ).toThrow('Ambiguous');
      expect(() =>
        acpSessionRegistry.remove('machine-a', 'legacy-pending'),
      ).toThrow('Ambiguous');
      await expect(
        releaseThread('machine-a', 'legacy-pending'),
      ).rejects.toThrow('Ambiguous');
      expect(entryA.client.shutdown).not.toHaveBeenCalled();
      expect(stopOnAgentlet).not.toHaveBeenCalled();
      response.resolve({ sessionId: 'pending-peer-native', pid: 202 });
      await pending;
      await releaseThread('machine-a', 'legacy-pending', namespaceB);
      expect(
        acpSessionRegistry.get('machine-a', 'legacy-pending', namespaceA),
      ).toBe(entryA);
    } finally {
      response.resolve({ sessionId: 'pending-peer-native', pid: 202 });
      await pending.catch(() => undefined);
      await releaseThread('machine-a', 'legacy-pending', namespaceB);
      acpSessionRegistry.remove('machine-a', 'legacy-pending', namespaceA);
    }
  });

  it('coalesces scoped startup, fences cleanup admissions, and lets another namespace progress', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{
      sessionId: string;
      pid: number;
    }>();
    const stopOnAgentlet = vi.fn(async () => ({
      stopped: true,
      disposition: 'stopped',
    }));
    const spawnOnAgentlet = vi.fn(
      (
        _id: string,
        args: { sessionSpec: { env?: Record<string, string> } },
      ) => {
        if (args.sessionSpec.env?.['OWNER'] === 'a') {
          started.resolve();
          return response.promise;
        }
        return Promise.resolve({ sessionId: 'independent-peer', pid: 303 });
      },
    );
    host.gateway = {
      getAgentlet: () => ({ agentletId: 'machine-a', status: 'connected' }),
      getSession: () => ({ status: 'connected' }),
      spawnOnAgentlet,
      stopOnAgentlet,
    };
    const openA = () =>
      ensureAgentForThread(
        'machine-a',
        'cleanup-pending',
        recipe,
        undefined,
        { OWNER: 'a' },
        600,
        'Deployment',
        namespaceA,
      );
    const first = openA();
    const coalesced = openA();
    let cleanup: Promise<void> | undefined;
    try {
      await started.promise;
      cleanup = releaseThread('machine-a', 'cleanup-pending', namespaceA);
      await expect(openA()).rejects.toThrow('closing');
      const peer = await ensureAgentForThread(
        'machine-a',
        'cleanup-pending',
        recipe,
        undefined,
        { OWNER: 'b' },
        600,
        'Deployment',
        namespaceB,
      );
      expect(peer.sessionId).toBe('independent-peer');
      expect(stopOnAgentlet).not.toHaveBeenCalled();
      response.resolve({ sessionId: 'owned-late-native', pid: 202 });
      expect(await first).toEqual(await coalesced);
      await cleanup;
      expect(stopOnAgentlet).toHaveBeenCalledTimes(1);
      expect(stopOnAgentlet).toHaveBeenCalledWith('machine-a', {
        sessionId: 'owned-late-native',
      });
      await releaseThread('machine-a', 'cleanup-pending', namespaceB);
    } finally {
      response.resolve({ sessionId: 'owned-late-native', pid: 202 });
      await Promise.allSettled([
        first,
        coalesced,
        ...(cleanup ? [cleanup] : []),
      ]);
      await releaseThread('machine-a', 'cleanup-pending', namespaceA);
      await releaseThread('machine-a', 'cleanup-pending', namespaceB);
    }
  });
});
