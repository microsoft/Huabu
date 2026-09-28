// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Skill authoring's promise that the Chat handle is down before it runs.
 *
 * A live Chat Deployment bakes its model tier at creation, so authoring tears
 * it down and lets the next ordinary turn rehydrate from durable input. That
 * only holds if the close has actually finished: closing is now a promise, and
 * a close merely *started* leaves the stale handle in the registry for the
 * authoring Job to find.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./memory/index.js', () => ({
  readWorkspaceMemory: () => '',
}));

import { AgentThreadService } from './agent-thread.service.js';

import type { HuabuSubmission } from './agenetes/handle.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { AgentStreamEvent } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

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

function envelope(authoring: boolean): ChatEnvelope {
  return {
    user: { text: 'Write a skill', attachments: [] },
    skills: {
      invokedIds: authoring ? ['create-skill'] : [],
      resolved: authoring
        ? [{ id: 'create-skill', name: 'Create Skill', body: '' }]
        : [],
    },
    focus: {
      selection: {
        refs: [],
        selectedIds: [],
        imageAttachments: [],
        snapshotAttachments: [],
      },
    },
  };
}

const SUBMISSION = {
  type: 'huabu.chat',
  content: {} as ChatEnvelope,
  rendered: [{ type: 'text', text: 'prepared' }],
} as HuabuSubmission;

/** Let every queued microtask and macrotask run before asserting a negative. */
const settleQueues = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const order: string[] = [];
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const closeHandle = vi.fn(async () => {
    order.push('close-started');
    await closed;
    order.push('close-settled');
  });
  const runInternal = vi.fn(() => {
    order.push('run');
    return (async function* () {
      yield { type: 'done', data: { message: 'Done' } } as AgentStreamEvent;
      return [];
    })();
  });
  const service = new AgentThreadService({
    resolveAgentNode: async () => null,
    resolveFixedAgentNode: async () => null,
    resolvePersistedExternalBinding: async () => null,
    resolvePersistedSpacePrompt: async () => ({ realised: false }),
    collectSpacePrompt: async () => null,
    realizeExternal: vi.fn(),
    waitForTurnRelease: vi.fn().mockResolvedValue(undefined),
    acquireTurn: vi.fn(() => vi.fn()),
    startLifecycle: vi.fn().mockResolvedValue(undefined),
    finishLifecycle: vi.fn().mockResolvedValue(undefined),
    failLifecycle: vi.fn().mockResolvedValue(undefined),
    runExternal: vi.fn(),
    runInternal: runInternal as never,
    closeHandle,
  });
  return { service, order, closeHandle, runInternal, finishClose };
}

function invoke(service: AgentThreadService, authoring: boolean) {
  return service.invoke({
    threadId: 'thread-a',
    content: 'Write a skill',
    mode: 'ask',
    envelope: envelope(authoring),
    submission: SUBMISSION,
    logger,
  });
}

describe('AgentThreadService skill-authoring dispatch', () => {
  it('waits for the live handle to be down before the authoring Job runs', async () => {
    const h = harness();
    const invocation = await invoke(h.service, true);

    const first = invocation.events.next();
    await settleQueues();
    expect(h.order).toEqual(['close-started']);
    expect(h.runInternal).not.toHaveBeenCalled();

    h.finishClose();
    await first;
    for await (const _event of invocation.events) {
      // Drain the authoring turn.
    }

    expect(h.order).toEqual(['close-started', 'close-settled', 'run']);
  });

  it("leaves an ordinary chat turn's handle alone", async () => {
    const h = harness();
    const invocation = await invoke(h.service, false);

    for await (const _event of invocation.events) {
      // Drain the ordinary turn.
    }

    expect(h.closeHandle).not.toHaveBeenCalled();
    expect(h.order).toEqual(['run']);
  });
});
