// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  AgentThreadBusyError,
  AgentThreadService,
} from './agent-thread.service.js';

import type { FixedAgentNodeTarget } from './agent-thread-resolver.js';
import type { runAgent } from './agent.service.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { AgentStreamEvent, CanvasNodeId } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const ENVELOPE: ChatEnvelope = {
  user: { text: 'Investigate this', attachments: [] },
  skills: { invokedIds: [], resolved: [] },
  focus: {
    selection: {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    },
  },
};

const TARGET: FixedAgentNodeTarget = {
  canvasId: 'canvas-a',
  nodeId: 'node-agent' as CanvasNodeId,
  threadId: 'thread-a',
  agentBinding: {
    kind: 'external',
    profileId: 'profile-fixed',
    alias: 'Fixed Agent',
  },
  launchOverrides: {
    workingDirPath: '/task/work',
    additionalInitialPreamble: 'Task constraints',
  },
  status: 'idle',
  content: '',
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  child: vi.fn(),
  level: 'info',
} as unknown as FastifyBaseLogger;

async function* events(
  values: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent, void> {
  for (const value of values) yield value;
}

function createHarness(options?: {
  target?: FixedAgentNodeTarget | null;
  busy?: boolean;
  externalEvents?: AgentStreamEvent[];
  startError?: Error;
  finishError?: Error;
}) {
  const release = vi.fn();
  const startLifecycle = options?.startError
    ? vi.fn().mockRejectedValue(options.startError)
    : vi.fn().mockResolvedValue(undefined);
  const finishLifecycle = options?.finishError
    ? vi.fn().mockRejectedValue(options.finishError)
    : vi.fn().mockResolvedValue(undefined);
  const failLifecycle = vi.fn().mockResolvedValue(undefined);
  const runExternal = vi.fn(() =>
    events(
      options?.externalEvents ?? [
        { type: 'text_delta', data: { content: 'Result' } },
        { type: 'done', data: { message: 'Done' } },
      ],
    ),
  );
  const runInternal = vi.fn(() => {
    async function* emptyInternalStream(): ReturnType<typeof runAgent> {
      yield* [];
      return [];
    }
    return emptyInternalStream();
  });
  const service = new AgentThreadService({
    resolveFixedAgentNode: () =>
      options && 'target' in options ? (options.target ?? null) : TARGET,
    waitForTurnRelease: vi.fn().mockResolvedValue(undefined),
    acquireTurn: vi.fn(() => (options?.busy ? null : release)),
    startLifecycle,
    finishLifecycle,
    failLifecycle,
    runExternal,
    runInternal,
    closeHandle: vi.fn(),
  });
  return {
    service,
    release,
    startLifecycle,
    finishLifecycle,
    failLifecycle,
    runExternal,
    runInternal,
  };
}

function invocationOptions() {
  return {
    threadId: 'thread-a',
    canvasId: 'canvas-a',
    content: 'Investigate this',
    mode: 'ask' as const,
    envelope: ENVELOPE,
    requestBinding: {
      kind: 'external' as const,
      profileId: 'profile-request',
      alias: 'Request Agent',
    },
    fixedTarget: TARGET,
    signal: new AbortController().signal,
    logger,
  };
}

describe('AgentThreadService', () => {
  it('uses persisted fixed binding and overrides under one leased lifecycle', async () => {
    const harness = createHarness();
    const invocation = await harness.service.invoke(invocationOptions());

    expect(harness.startLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Investigate this',
    );
    expect(harness.runExternal).not.toHaveBeenCalled();

    const emitted: AgentStreamEvent[] = [];
    for await (const event of invocation.events) emitted.push(event);

    expect(invocation.binding).toEqual(TARGET.agentBinding);
    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'done']);
    expect(harness.runExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: TARGET.agentBinding,
        launchOverrides: TARGET.launchOverrides,
      }),
    );
    expect(harness.finishLifecycle).toHaveBeenCalledWith(TARGET);
    expect(harness.failLifecycle).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('writes an error terminal for a failed fixed-node stream', async () => {
    const harness = createHarness({
      externalEvents: [{ type: 'error', data: { error: 'Agent unavailable' } }],
    });
    const invocation = await harness.service.invoke(invocationOptions());

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.failLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Agent unavailable',
    );
    expect(harness.finishLifecycle).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('does not dispatch when the start lifecycle patch fails', async () => {
    const harness = createHarness({
      startError: new Error('Canvas update failed'),
    });

    await expect(harness.service.invoke(invocationOptions())).rejects.toThrow(
      'Canvas update failed',
    );
    expect(harness.runExternal).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('reports a busy thread without starting lifecycle or dispatch', async () => {
    const harness = createHarness({ busy: true });

    await expect(
      harness.service.invoke(invocationOptions()),
    ).rejects.toBeInstanceOf(AgentThreadBusyError);
    expect(harness.startLifecycle).not.toHaveBeenCalled();
    expect(harness.runExternal).not.toHaveBeenCalled();
  });

  it('surfaces terminal lifecycle failures and still releases the lease', async () => {
    const harness = createHarness({
      finishError: new Error('Terminal Canvas update failed'),
    });
    const invocation = await harness.service.invoke(invocationOptions());

    await expect(async () => {
      for await (const _event of invocation.events) {
        // Drain the canonical invocation stream.
      }
    }).rejects.toThrow('Terminal Canvas update failed');
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('can dispose an invocation before its lazy stream starts', async () => {
    const harness = createHarness();
    const invocation = await harness.service.invoke(invocationOptions());

    await invocation.dispose(new Error('SSE setup failed'));

    expect(harness.runExternal).not.toHaveBeenCalled();
    expect(harness.failLifecycle).toHaveBeenCalledWith(
      TARGET,
      'SSE setup failed',
    );
    expect(harness.release).toHaveBeenCalledOnce();
  });
});
