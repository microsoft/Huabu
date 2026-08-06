import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  gateway: {
    getSession: vi.fn(),
  },
}));

const orchestrator = vi.hoisted(() => ({
  ensureAgentForThread: vi.fn(),
}));

const clients = vi.hoisted(() => ({
  created: [] as Array<{
    isClosed: boolean;
    seedFromRecord: ReturnType<typeof vi.fn>;
    registerSessionListener: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentletGateway: () => host.gateway,
}));

vi.mock('./spawn-orchestrator.js', () => orchestrator);

vi.mock('./client.js', () => ({
  AcpAgentClient: class {
    readonly isClosed = false;
    readonly seedFromRecord = vi.fn();
    readonly registerSessionListener = vi.fn();
    readonly shutdown = vi.fn();

    constructor() {
      clients.created.push(this);
    }
  },
}));

import { acpSessionRegistry } from './session-registry.js';
import { ensureAcpSession } from './session.js';

import type { AcpBindingRecipe } from './binding-recipe.js';
import type { AcpAgentClient } from './client.js';
import type { AcpSessionEntry } from './session-registry.js';

const agentletId = 'machine-a';
const threadId = 'thread-1';
const namespace = { name: 'canvas-1' };
const binding = { alias: 'copilot', profileId: 'profile-1' };
const recipe: AcpBindingRecipe = {
  alias: binding.alias,
  command: 'copilot --acp',
  autoRestart: false,
};
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function closedEntry(
  overrides: Partial<AcpSessionEntry> = {},
): AcpSessionEntry {
  return {
    agentletId,
    threadId,
    client: {
      isClosed: true,
      shutdown: vi.fn(),
    } as unknown as AcpAgentClient,
    sessionId: 'session-old',
    profileId: binding.profileId,
    namespace,
    cwd: '/repo',
    createdAt: 1,
    bindingRecipe: recipe,
    persistedToDisk: true,
    initialPreambleDelivered: true,
    availableCommands: [],
    commandsUpdatedAt: 0,
    availableModes: [],
    currentModeId: 'ask',
    availableModels: [],
    currentModelId: 'model-1',
    configOptions: [],
    sessionInfo: null,
    usage: null,
    metaUpdatedAt: 10,
    ...overrides,
  };
}

function ensureOptions() {
  return {
    agentletId,
    threadId,
    binding,
    namespace,
    recipe,
    priorState: {
      driverState: {
        sessionId: 'session-from-create-context',
        initialPreambleDelivered: false,
      },
    },
    logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clients.created.length = 0;
  host.gateway.getSession.mockReturnValue({
    status: 'connected',
    sessionProfile: undefined,
  });
});

afterEach(() => {
  acpSessionRegistry.remove(agentletId, threadId);
});

describe('ACP Handle session self-repair', () => {
  it('repairs a closed committed entry from its latest session state', async () => {
    const oldEntry = closedEntry();
    acpSessionRegistry.set(agentletId, threadId, oldEntry);
    let finishSpawn:
      | ((value: { sessionId: string; pid: number }) => void)
      | undefined;
    orchestrator.ensureAgentForThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve;
        }),
    );

    const first = ensureAcpSession(ensureOptions());
    const second = ensureAcpSession(ensureOptions());
    await vi.waitFor(() => {
      expect(orchestrator.ensureAgentForThread).toHaveBeenCalledOnce();
    });

    expect(acpSessionRegistry.get(agentletId, threadId)).toBe(oldEntry);
    expect(orchestrator.ensureAgentForThread).toHaveBeenCalledWith(
      agentletId,
      threadId,
      recipe,
      'session-old',
      undefined,
      undefined,
    );

    finishSpawn?.({ sessionId: 'session-repaired', pid: 42 });
    const [repaired, coalesced] = await Promise.all([first, second]);

    expect(coalesced).toBe(repaired);
    expect(repaired).toMatchObject({
      sessionId: 'session-repaired',
      persistedToDisk: true,
      initialPreambleDelivered: true,
      currentModeId: 'ask',
      currentModelId: 'model-1',
    });
    expect(oldEntry.client.shutdown).toHaveBeenCalledWith('session_replaced');
    expect(acpSessionRegistry.get(agentletId, threadId)).toBe(repaired);
  });

  it('does not resume an uncommitted empty session', async () => {
    const oldEntry = closedEntry({
      persistedToDisk: false,
      initialPreambleDelivered: false,
    });
    acpSessionRegistry.set(agentletId, threadId, oldEntry);
    orchestrator.ensureAgentForThread.mockResolvedValueOnce({
      sessionId: 'session-new',
      pid: 43,
    });

    const repaired = await ensureAcpSession(ensureOptions());

    expect(orchestrator.ensureAgentForThread).toHaveBeenCalledWith(
      agentletId,
      threadId,
      recipe,
      undefined,
      undefined,
      undefined,
    );
    expect(repaired.persistedToDisk).toBe(false);
  });

  it('retains the closed entry when repair fails', async () => {
    const oldEntry = closedEntry();
    acpSessionRegistry.set(agentletId, threadId, oldEntry);
    orchestrator.ensureAgentForThread.mockRejectedValueOnce(
      new Error('spawn failed'),
    );

    await expect(ensureAcpSession(ensureOptions())).rejects.toThrow(
      'spawn failed',
    );

    expect(acpSessionRegistry.get(agentletId, threadId)).toBe(oldEntry);
    expect(oldEntry.client.shutdown).not.toHaveBeenCalled();
  });

  it('reuses a live matching entry without spawning', async () => {
    const liveEntry = closedEntry({
      client: {
        isClosed: false,
        shutdown: vi.fn(),
      } as unknown as AcpAgentClient,
    });
    acpSessionRegistry.set(agentletId, threadId, liveEntry);

    await expect(ensureAcpSession(ensureOptions())).resolves.toBe(liveEntry);
    expect(orchestrator.ensureAgentForThread).not.toHaveBeenCalled();
  });
});
