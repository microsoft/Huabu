// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildChatEnvelope: vi.fn(),
  prepareAgentSubmission: vi.fn(),
  beginPreparation: vi.fn(),
  resolveFixedTarget: vi.fn(),
  resolveTarget: vi.fn(),
  resolveBinding: vi.fn(),
  invoke: vi.fn(),
  stopAndWait: vi.fn(),
}));

vi.mock('./conversation/envelope.js', () => ({
  buildChatEnvelope: mocks.buildChatEnvelope,
  InkVisualPreparationError: class extends Error {
    readonly code = 'ink_visual_unavailable';
  },
}));

vi.mock('./agent-submission.js', () => ({
  prepareAgentSubmission: mocks.prepareAgentSubmission,
  InkModelCapabilityError: class extends Error {
    readonly code = 'ink_model_unsupported';
  },
}));

vi.mock('./agent-thread.service.js', () => {
  class AgentThreadBusyError extends Error {}

  return {
    AgentThreadBusyError,
    agentThreadService: {
      resolveFixedTarget: mocks.resolveFixedTarget,
      resolveTarget: mocks.resolveTarget,
      resolveBinding: mocks.resolveBinding,
      beginPreparation: mocks.beginPreparation,
      invoke: mocks.invoke,
      stopAndWait: mocks.stopAndWait,
    },
  };
});

vi.mock('./acp/external-agent-realization.js', () => ({
  ExternalAgentRealizationError: class extends Error {
    readonly code = 'external_realization_failed';
  },
}));

vi.mock('./agenetes/drivers.js', () => ({
  INTERNAL_DRIVER_KIND: 'internal',
  agenetes: {
    logMetadata: () => ({ turnCount: 0 }),
  },
}));

vi.mock('./conversation/transcript/history.js', () => ({
  buildHistoryFromTurns: vi.fn(),
}));

vi.mock('./llm.js', () => ({
  getLLMModel: vi.fn(),
}));

vi.mock('../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => `test/${canvasId}`,
}));

import agentRoutes from './agent.route.js';

import type { AgentStreamEvent, ChatEnvelope } from '@huabu/shared';

const ENVELOPE: ChatEnvelope = {
  user: { text: '', inputKind: 'ink-intent', attachments: [] },
  skills: { invokedIds: [], resolved: [] },
  focus: {
    selection: {
      refs: [],
      selectedIds: ['sketch-a'],
      imageAttachments: [],
      snapshotAttachments: [],
      strokeSubsets: [{ nodeId: 'sketch-a', strokeIds: ['stroke-a'] }],
    },
  },
};

async function* events(): AsyncGenerator<AgentStreamEvent, void> {
  yield { type: 'done', data: { message: 'Done' } };
}

async function* failsBeforeFirstEvent(): AsyncGenerator<
  AgentStreamEvent,
  void
> {
  yield* [];
  throw new Error('Agent failed before its first event');
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue(null);
  mocks.resolveBinding.mockImplementation(
    ({ requestBinding }: { requestBinding?: unknown }) =>
      requestBinding ?? { kind: 'internal' },
  );
  mocks.prepareAgentSubmission.mockResolvedValue({
    type: 'huabu.chat',
    content: ENVELOPE,
    rendered: [{ type: 'text', text: 'Prepared' }],
  });
  mocks.beginPreparation.mockReturnValue({
    signal: new AbortController().signal,
    finish: vi.fn(),
  });
});

describe('POST /agent', () => {
  it('admits Ink in Ask mode and streams acceptance without upgrading the request', async () => {
    mocks.beginPreparation.mockReturnValue({
      signal: new AbortController().signal,
      finish: vi.fn(),
    });
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.resolveTarget.mockResolvedValue(null);
    mocks.buildChatEnvelope.mockResolvedValue(ENVELOPE);
    mocks.invoke.mockImplementationOnce(async (options) => {
      await options.envelope();
      return {
        binding: { kind: 'internal' },
        fixedTarget: null,
        signal: new AbortController().signal,
        acceptance: Promise.resolve({
          threadId: 'thread-a',
          turnStartSeq: 1,
        }),
        events: events(),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    });
    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          inputKind: 'ink-intent',
          content: '',
          threadId: 'thread-a',
          canvasId: 'canvas-a',
          mode: 'ask',
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-a',
                type: 'sketch',
                strokeIds: ['stroke-a'],
              },
            ],
          },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'ask' }),
      );
      expect(mocks.buildChatEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ inputKind: 'ink-intent', content: '' }),
      );
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('event: accepted');
      expect(response.body).toContain('event: done');
    } finally {
      await app.close();
    }
  });

  it('returns durable acceptance from the shared stop path', async () => {
    mocks.stopAndWait.mockResolvedValue({
      stopped: true,
      acceptance: { threadId: 'thread-a', turnStartSeq: 2 },
    });
    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent/stop/thread-a',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        stopped: true,
        acceptance: { threadId: 'thread-a', turnStartSeq: 2 },
      });
    } finally {
      await app.close();
    }
  });

  it('passes Ink semantics into the envelope and emits durable acceptance first', async () => {
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.buildChatEnvelope.mockResolvedValue(ENVELOPE);
    mocks.invoke.mockImplementation(async (options) => {
      await options.envelope();
      return {
        binding: { kind: 'internal' },
        fixedTarget: null,
        signal: new AbortController().signal,
        acceptance: Promise.resolve({
          threadId: 'thread-a',
          turnStartSeq: 1,
        }),
        events: events(),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    });

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          inputKind: 'ink-intent',
          content: '',
          threadId: 'thread-a',
          mode: 'operate',
          canvasId: 'canvas-a',
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-a',
                type: 'sketch',
                strokeIds: ['stroke-a'],
              },
            ],
          },
          agentBinding: { kind: 'internal' },
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(mocks.buildChatEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ inputKind: 'ink-intent', content: '' }),
      );
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          envelope: expect.any(Function),
        }),
      );
      const eventNames = [...response.body.matchAll(/^event: (.+)$/gm)].map(
        (match) => match[1],
      );
      expect(eventNames).toEqual(['meta', 'accepted', 'done', 'end']);
      expect(response.body).toContain(
        'data: {"threadId":"thread-a","turnStartSeq":1}',
      );
    } finally {
      await app.close();
    }
  });

  it('uses the thread owner as the authoritative Question anchor', async () => {
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.resolveTarget.mockResolvedValue({
      canvasId: 'canvas-a',
      nodeId: 'question-a',
      threadId: 'thread-a',
      agentMode: 'operate',
    });
    mocks.buildChatEnvelope.mockResolvedValue(ENVELOPE);
    mocks.invoke.mockImplementation(async (options) => {
      await options.envelope();
      return {
        binding: { kind: 'internal' },
        fixedTarget: null,
        signal: new AbortController().signal,
        acceptance: Promise.resolve(null),
        events: events(),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    });

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          content: 'Continue',
          threadId: 'thread-a',
          mode: 'ask',
          canvasId: 'canvas-a',
          anchorNodeId: 'question-a',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(mocks.buildChatEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ anchorNodeId: 'question-a' }),
      );
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'operate',
          agentTarget: expect.objectContaining({ nodeId: 'question-a' }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects an anchor that does not own the thread', async () => {
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.resolveTarget.mockResolvedValue({
      canvasId: 'canvas-a',
      nodeId: 'question-a',
      threadId: 'thread-a',
      agentMode: 'ask',
    });

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          content: 'Continue',
          threadId: 'thread-a',
          canvasId: 'canvas-a',
          anchorNodeId: 'question-b',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'conversation_owner_mismatch',
      });
      expect(mocks.buildChatEnvelope).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an anchor when the thread has no Question owner', async () => {
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.resolveTarget.mockResolvedValue(null);

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          content: 'Continue',
          threadId: 'thread-a',
          canvasId: 'canvas-a',
          anchorNodeId: 'question-a',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'conversation_owner_mismatch',
      });
      expect(mocks.buildChatEnvelope).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('emits durable acceptance before an error raised ahead of the first event', async () => {
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.buildChatEnvelope.mockResolvedValue(ENVELOPE);
    mocks.invoke.mockResolvedValue({
      binding: { kind: 'internal' },
      fixedTarget: null,
      signal: new AbortController().signal,
      acceptance: Promise.resolve({
        threadId: 'thread-a',
        turnStartSeq: 1,
      }),
      events: failsBeforeFirstEvent(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          inputKind: 'ink-intent',
          content: '',
          threadId: 'thread-a',
          mode: 'operate',
          canvasId: 'canvas-a',
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-a',
                type: 'sketch',
                strokeIds: ['stroke-a'],
              },
            ],
          },
          agentBinding: { kind: 'internal' },
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(
        [...response.body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]),
      ).toEqual(['meta', 'accepted', 'error']);
    } finally {
      await app.close();
    }
  });

  it('rejects unavailable required Ink before starting a thread', async () => {
    const failure = Object.assign(new Error('Select the strokes again.'), {
      name: 'InkVisualPreparationError',
      code: 'ink_visual_unavailable',
    });
    const { InkVisualPreparationError } =
      await import('./conversation/envelope.js');
    Object.setPrototypeOf(failure, InkVisualPreparationError.prototype);
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.buildChatEnvelope.mockRejectedValue(failure);
    mocks.invoke.mockImplementation(async (options) => {
      await options.envelope();
      throw failure;
    });

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          inputKind: 'ink-intent',
          content: '',
          threadId: 'thread-a',
          mode: 'operate',
          canvasId: 'canvas-a',
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-a',
                type: 'sketch',
                strokeIds: ['stroke-a'],
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        message: 'Select the strokes again.',
        code: 'ink_visual_unavailable',
      });
      expect(mocks.invoke).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('rejects a non-vision built-in model before invocation and SSE', async () => {
    const failure = Object.assign(new Error('Vision is required.'), {
      name: 'InkModelCapabilityError',
      code: 'ink_model_unsupported',
    });
    const { InkModelCapabilityError } = await import('./agent-submission.js');
    Object.setPrototypeOf(failure, InkModelCapabilityError.prototype);
    mocks.resolveFixedTarget.mockResolvedValue(null);
    mocks.buildChatEnvelope.mockResolvedValue(ENVELOPE);
    mocks.invoke.mockRejectedValue(failure);

    const app = Fastify();
    await app.register(agentRoutes, { prefix: '/agent' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/agent',
        payload: {
          inputKind: 'ink-intent',
          content: '',
          threadId: 'thread-a',
          canvasId: 'canvas-a',
          canvasContext: {
            selectedNodes: [
              {
                id: 'sketch-a',
                type: 'sketch',
                strokeIds: ['stroke-a'],
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'ink_model_unsupported',
      });
      expect(mocks.invoke).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
