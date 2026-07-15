import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  gateway: undefined as unknown,
}));

vi.mock('@agenetes/agentlet-host', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentletHostModule>();
  return {
    ...actual,
    getAgentletGateway: () => host.gateway,
    getSupervisedAgentletId: () => 'machine-a',
    getDaemonSupervisor: () => ({
      getStatus: () => ({ online: false }),
      hasGivenUp: () => false,
    }),
  };
});

import { acpSessionRegistry } from './session-registry.js';
import {
  _resetSpawnOrchestratorForTests,
  ensureAgentForThread,
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
  it('isolates live session registry entries by placement and thread', () => {
    const entryA = {
      agentletId: 'machine-a',
      threadId: 'thread-1',
      client: { shutdown: vi.fn() } as unknown as AcpAgentClient,
    } as AcpSessionEntry;
    const entryB = {
      agentletId: 'machine-b',
      threadId: 'thread-1',
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
