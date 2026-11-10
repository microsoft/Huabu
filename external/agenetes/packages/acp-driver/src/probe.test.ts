import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { awaitSchemaQuiescence, probeAcpCapabilities } from './probe.js';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
}));
vi.mock('./session.js', () => ({ ensureAcpSession: mocks.ensure }));
vi.mock('./session-registry.js', () => ({
  acpSessionRegistry: { remove: mocks.remove },
}));
vi.mock('./spawn-orchestrator.js', () => ({ releaseThread: mocks.release }));

const options = {
  agentletId: 'machine',
  binding: { profileId: 'profile', alias: 'Agent' },
  recipe: {
    command: 'agent --acp',
    cwd: '/project',
    autoRestart: false,
    alias: 'Agent',
  },
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
};
const empty = () => ({
  client: { isClosed: false },
  availableModes: [],
  availableModels: [],
  configOptions: [],
  currentModeId: null,
  currentModelId: null,
  availableCommands: [],
  commandsUpdatedAt: 0,
  metaUpdatedAt: 0,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('ephemeral ACP capability probe', () => {
  it('uses an isolated non-durable Job and collects late updates before releasing the process', async () => {
    const entry = empty();
    mocks.ensure.mockResolvedValue(entry);
    const result = probeAcpCapabilities(options);
    setTimeout(() => {
      Object.assign(entry, {
        availableModels: [{ modelId: 'fast', name: 'Fast' }],
        availableCommands: [{ name: 'help' }],
        metaUpdatedAt: 1,
      });
    }, 100);
    await vi.advanceTimersByTimeAsync(500);
    const observation = await result;
    expect(observation.availableModels).toEqual([
      { modelId: 'fast', name: 'Fast' },
    ]);
    expect(observation.availableCommands).toEqual([{ name: 'help' }]);
    const request = mocks.ensure.mock.calls[0][0];
    expect(request).toMatchObject({
      workloadType: 'Job',
      threadId: expect.stringMatching(/^capability-probe-/),
      namespace: { name: 'capability-probe' },
      idleTimeoutSecs: 60,
    });
    expect(request).not.toHaveProperty('env');
    expect(request).not.toHaveProperty('priorState');
    expect(request).not.toHaveProperty('initialPreferences');
    expect(request.namespace).not.toHaveProperty('storage');
    expect(mocks.remove).toHaveBeenCalledWith(
      'machine',
      request.threadId,
      request.namespace,
    );
    expect(mocks.release).toHaveBeenCalledWith(
      'machine',
      request.threadId,
      request.namespace,
    );
    entry.metaUpdatedAt = 99;
    expect(observation.metaUpdatedAt).not.toBe(99);
  });

  it('cleans up even when session initialization fails', async () => {
    mocks.ensure.mockRejectedValue(new Error('failed to initialize'));
    await expect(probeAcpCapabilities(options)).rejects.toThrow(
      'failed to initialize',
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(
      'machine',
      mocks.ensure.mock.calls[0][0].threadId,
      mocks.ensure.mock.calls[0][0].namespace,
    );
  });

  it('surfaces process reclamation failure rather than returning success', async () => {
    mocks.ensure.mockResolvedValue(empty());
    mocks.release.mockRejectedValue(new Error('stop failed'));
    const result = expect(probeAcpCapabilities(options)).rejects.toThrow(
      'stop failed',
    );
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });

  it('does not cache an empty success after the agent disconnects', async () => {
    const entry = empty();
    entry.client.isClosed = true;
    mocks.ensure.mockResolvedValue(entry);
    const result = expect(probeAcpCapabilities(options)).rejects.toThrow(
      'Agent disconnected',
    );
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('retains both initialization and cleanup errors', async () => {
    const initialization = new Error('initialize failed');
    const cleanup = new Error('stop failed');
    mocks.ensure.mockRejectedValue(initialization);
    mocks.release.mockRejectedValue(cleanup);
    await expect(probeAcpCapabilities(options)).rejects.toMatchObject({
      errors: [initialization, cleanup],
    });
  });

  it('caps observation time for an agent that keeps updating', async () => {
    const entry = empty();
    const timer = setInterval(() => entry.metaUpdatedAt++, 5);
    let done = false;
    const result = awaitSchemaQuiescence(entry, {
      pollIntervalMs: 5,
      quietWindowMs: 20,
      maxWaitMs: 60,
    }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(55);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    await result;
    expect(done).toBe(true);
    clearInterval(timer);
  });
});
