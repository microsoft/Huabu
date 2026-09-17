// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./memory/index.js', () => ({
  readWorkspaceMemory: () => '',
}));

import { createInteractiveViewSubmission } from './agenetes/handle.js';
import {
  AgentThreadBusyError,
  AgentThreadService,
  externalBindingFromWorkloadSpec,
  spacePromptFromWorkloadSpec,
} from './agent-thread.service.js';

import type { AcpHandle, AcpWorkloadSpec } from './agenetes/drivers.js';
import type {
  AgentNodeTarget,
  FixedAgentNodeTarget,
} from './agent-thread-resolver.js';
import type { runAgent } from './agent.service.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type {
  AgentBinding,
  AgentStreamEvent,
  CanvasNodeId,
} from '@huabu/shared';
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

const SELECTABLE_TARGET: AgentNodeTarget = {
  canvasId: 'canvas-a',
  nodeId: 'node-selectable' as CanvasNodeId,
  threadId: 'thread-a',
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
  agentTarget?: AgentNodeTarget | null;
  target?: FixedAgentNodeTarget | null;
  busy?: boolean;
  externalEvents?: AgentStreamEvent[];
  startError?: Error;
  finishError?: Error;
  persistedBinding?: Extract<AgentBinding, { kind: 'external' }> | null;
  persistedSpacePrompt?: { realised: boolean; markdown?: string };
  collectedSpacePrompt?: string;
  canonicalBinding?: AgentBinding;
}) {
  const release = vi.fn();
  const startLifecycle = options?.startError
    ? vi.fn().mockRejectedValue(options.startError)
    : vi.fn().mockResolvedValue(undefined);
  const finishLifecycle = options?.finishError
    ? vi.fn().mockRejectedValue(options.finishError)
    : vi.fn().mockResolvedValue(undefined);
  const failLifecycle = vi.fn().mockResolvedValue(undefined);
  const runExternal = vi.fn((runOptions: { onTurnStarted?: () => void }) => {
    runOptions.onTurnStarted?.();
    return events(
      options?.externalEvents ?? [
        { type: 'text_delta', data: { content: 'Result' } },
        { type: 'done', data: { message: 'Done' } },
      ],
    );
  });
  const runInternal = vi.fn((runOptions: { onTurnStarted?: () => void }) => {
    runOptions.onTurnStarted?.();
    async function* emptyInternalStream(): ReturnType<typeof runAgent> {
      yield* [];
      return [];
    }
    return emptyInternalStream();
  });
  const collectSpacePrompt = vi.fn().mockResolvedValue({
    markdown: options?.collectedSpacePrompt ?? 'Space prompt',
    diagnostics: {
      includedFrameIds: ['frame-prompt'],
      includedNodeIds: ['text-prompt'],
      omittedUnsupportedIds: [],
      omittedEmptyTextIds: [],
      omittedMissingIds: [],
      omittedBudgetNodeIds: [],
      truncatedNoteIds: [],
      truncated: false,
    },
  });
  const realizeExternal = vi.fn(
    async ({
      requestedBinding,
      fixedTarget,
    }: {
      agentTarget?: AgentNodeTarget | null;
      requestedBinding?: Extract<AgentBinding, { kind: 'external' }>;
      fixedTarget?: FixedAgentNodeTarget | null;
    }) => {
      const binding =
        fixedTarget?.agentBinding.kind === 'external'
          ? fixedTarget.agentBinding
          : requestedBinding;
      if (!binding) throw new Error('Missing external binding');
      return {
        binding,
        fixedTarget: fixedTarget ?? null,
        spec: {} as AcpWorkloadSpec,
        handle: {} as AcpHandle,
      };
    },
  );
  const service = new AgentThreadService({
    resolveAgentNode: async () =>
      options && 'agentTarget' in options
        ? (options.agentTarget ?? null)
        : options && 'target' in options
          ? (options.target ?? null)
          : TARGET,
    resolveFixedAgentNode: async () =>
      options && 'target' in options ? (options.target ?? null) : TARGET,
    resolvePersistedExternalBinding: () =>
      options && 'persistedBinding' in options
        ? (options.persistedBinding ?? null)
        : null,
    resolvePersistedSpacePrompt: () =>
      options?.persistedSpacePrompt ?? { realised: false },
    collectSpacePrompt,
    realizeExternal,
    waitForTurnRelease: vi.fn().mockResolvedValue(undefined),
    acquireTurn: vi.fn(() => (options?.busy ? null : release)),
    startLifecycle,
    finishLifecycle,
    failLifecycle,
    runExternal,
    runInternal,
    closeHandle: vi.fn(),
    confirmBinding: options?.canonicalBinding
      ? vi.fn().mockResolvedValue(options.canonicalBinding)
      : undefined,
  });
  return {
    service,
    release,
    startLifecycle,
    finishLifecycle,
    failLifecycle,
    runExternal,
    runInternal,
    collectSpacePrompt,
    realizeExternal,
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
      profileId: 'profile-fixed',
      alias: 'Fixed Agent',
    },
    requestedCwd: '/task/work',
    fixedTarget: TARGET,
    signal: new AbortController().signal,
    logger,
  };
}

describe('AgentThreadService', () => {
  it('keeps slow input preparation inside cancellable admission and never dispatches after stop', async () => {
    const h = createHarness();
    let finishPreparation!: () => void;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const pending = h.service.invoke({
      ...invocationOptions(),
      envelope: async () => {
        started();
        await preparation;
        return ENVELOPE;
      },
    });
    await preparing;
    expect(h.startLifecycle).toHaveBeenCalledOnce();
    expect(h.service.stop('thread-a')).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    finishPreparation();
    const invocation = await pending;
    for await (const _event of invocation.events) {
      /* Drain cancelled preparation. */
    }
    expect(h.realizeExternal).not.toHaveBeenCalled();
    expect(h.runExternal).not.toHaveBeenCalled();
    expect(h.finishLifecycle).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('projects input preparation failures with the admitted token and does not realize an execution', async () => {
    const h = createHarness();
    await expect(
      h.service.invoke({
        ...invocationOptions(),
        envelope: async () => {
          throw new Error('Input preparation failed');
        },
      }),
    ).rejects.toThrow('Input preparation failed');
    expect(h.failLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Input preparation failed',
      h.startLifecycle.mock.calls[0]?.[2],
    );
    expect(h.realizeExternal).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('admits and installs cancellation before slow external preparation', async () => {
    const h = createHarness();
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    h.realizeExternal.mockImplementationOnce(async () => {
      preparationStarted();
      await preparation;
      return {
        binding: TARGET.agentBinding as Extract<
          AgentBinding,
          { kind: 'external' }
        >,
        fixedTarget: TARGET,
        spec: {} as AcpWorkloadSpec,
        handle: {} as AcpHandle,
      };
    });
    const pending = h.service.invoke(invocationOptions());
    await started;
    expect(h.startLifecycle).toHaveBeenCalledOnce();
    expect(h.service.isActive('thread-a', 'canvas-a')).toBe(true);
    expect(h.service.stop('thread-a')).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    finishPreparation();
    const invocation = await pending;
    for await (const _event of invocation.events) {
      /* Drain settlement. */
    }
    expect(h.runExternal).not.toHaveBeenCalled();
    expect(h.finishLifecycle).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.service.isActive('thread-a', 'canvas-a')).toBe(false);
  });

  it('settles preparation errors and retains the admitted token', async () => {
    const h = createHarness();
    h.realizeExternal.mockRejectedValueOnce(new Error('Profile unavailable'));
    await expect(h.service.invoke(invocationOptions())).rejects.toThrow(
      'Profile unavailable',
    );
    const token = h.startLifecycle.mock.calls[0]?.[2];
    expect(h.failLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Profile unavailable',
      token,
    );
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.runExternal).not.toHaveBeenCalled();
  });

  it('treats cancellation unwinding preparation as cancellation, not an HTTP preparation error', async () => {
    const h = createHarness();
    h.realizeExternal.mockImplementationOnce(async () => {
      h.service.stop('thread-a');
      throw new DOMException('Stopped during preparation', 'AbortError');
    });
    const invocation = await h.service.invoke(invocationOptions());
    expect(invocation.signal.aborted).toBe(true);
    for await (const _event of invocation.events) {
      /* Drain cancelled preparation. */
    }
    expect(h.finishLifecycle).toHaveBeenCalledOnce();
    expect(h.failLifecycle).not.toHaveBeenCalled();
    expect(h.runExternal).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('rejects stale requested selection without a lifecycle transition or realization', async () => {
    const h = createHarness();
    await expect(
      h.service.invoke({
        ...invocationOptions(),
        requestBinding: {
          kind: 'external',
          profileId: 'stale',
          alias: 'Old selection',
        },
      }),
    ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
    expect(h.startLifecycle).not.toHaveBeenCalled();
    expect(h.realizeExternal).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('rejects an internal node whose confirmed execution uses an external binding without a request binding', async () => {
    const h = createHarness({
      target: null,
      agentTarget: { ...SELECTABLE_TARGET, agentBinding: { kind: 'internal' } },
      canonicalBinding: {
        kind: 'external',
        profileId: 'other',
        alias: 'Other',
      },
    });
    await expect(
      h.service.invoke({
        ...invocationOptions(),
        requestBinding: undefined,
      }),
    ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
    expect(h.realizeExternal).not.toHaveBeenCalled();
    expect(h.runInternal).not.toHaveBeenCalled();
    expect(h.failLifecycle).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('does not turn a captured preparation failure into success when cancellation arrives before the catch', async () => {
    const h = createHarness();
    h.realizeExternal.mockImplementationOnce(async () => {
      const failure = new Error('Canonical record invalid');
      queueMicrotask(() => h.service.stop('thread-a'));
      throw failure;
    });
    await expect(h.service.invoke(invocationOptions())).rejects.toThrow(
      'Canonical record invalid',
    );
    expect(h.failLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Canonical record invalid',
      expect.any(String),
    );
    expect(h.finishLifecycle).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('cannot run a lazy stream after explicit disposal released admission', async () => {
    const h = createHarness();
    const invocation = await h.service.invoke(invocationOptions());
    await invocation.dispose(new Error('Transport setup failed'));
    for await (const _event of invocation.events) {
      /* Drain disposed stream. */
    }
    expect(h.runExternal).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'empty output', stream: [] as AgentStreamEvent[], outcome: 'done' },
    {
      name: 'Done after an error',
      stream: [
        { type: 'error', data: { error: 'Recoverable' } },
        { type: 'done', data: { message: '' } },
      ] as AgentStreamEvent[],
      outcome: 'done',
    },
    {
      name: 'error after Done',
      stream: [
        { type: 'done', data: { message: '' } },
        { type: 'error', data: { error: 'Late error' } },
      ] as AgentStreamEvent[],
      outcome: 'done',
    },
    {
      name: 'a handled tool error',
      stream: [
        {
          type: 'tool_call',
          data: { toolCallId: 'tool', title: 'read', status: 'failed' },
        },
      ] as AgentStreamEvent[],
      outcome: 'done',
    },
    {
      name: 'an unhandled stream error',
      stream: [
        { type: 'error', data: { error: 'Failed' } },
      ] as AgentStreamEvent[],
      outcome: 'error',
    },
  ])('preserves terminal precedence for $name', async ({ stream, outcome }) => {
    const h = createHarness({ externalEvents: stream });
    const invocation = await h.service.invoke(invocationOptions());
    for await (const _event of invocation.events) {
      /* Drain characterized events. */
    }
    expect(h.finishLifecycle).toHaveBeenCalledTimes(outcome === 'done' ? 1 : 0);
    expect(h.failLifecycle).toHaveBeenCalledTimes(outcome === 'error' ? 1 : 0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(['done', 'error'] as const)(
    'a late stop cannot rewrite an established %s fact',
    async (outcome) => {
      const h = createHarness({
        externalEvents:
          outcome === 'done'
            ? [{ type: 'done', data: { message: '' } }]
            : [{ type: 'error', data: { error: 'Failure' } }],
      });
      const controller = new AbortController();
      const invocation = await h.service.invoke({
        ...invocationOptions(),
        signal: controller.signal,
      });
      const stream = invocation.events;
      await stream.next();
      expect(h.service.stop('thread-a')).toBe(false);
      controller.abort();
      await stream.next();
      expect(h.failLifecycle).toHaveBeenCalledTimes(
        outcome === 'error' ? 1 : 0,
      );
      expect(h.finishLifecycle).toHaveBeenCalledTimes(
        outcome === 'done' ? 1 : 0,
      );
    },
  );

  it('preserves cancellation when the adapter reports an error after stop', async () => {
    const h = createHarness({
      externalEvents: [
        { type: 'text_delta', data: { content: 'Partial' } },
        { type: 'error', data: { error: 'Aborted' } },
      ],
    });
    const invocation = await h.service.invoke(invocationOptions());
    await invocation.events.next();
    expect(h.service.stop('thread-a')).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    await invocation.events.next();
    await invocation.events.next();
    expect(h.finishLifecycle).toHaveBeenCalledOnce();
    expect(h.failLifecycle).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(['done', 'error'] as const)(
    'stream disposal retains an established %s outcome',
    async (outcome) => {
      const h = createHarness({
        externalEvents:
          outcome === 'done'
            ? [{ type: 'done', data: { message: '' } }]
            : [{ type: 'error', data: { error: 'Original failure' } }],
      });
      const invocation = await h.service.invoke(invocationOptions());
      await invocation.events.next();
      await invocation.dispose(new Error('Late transport failure'));
      await invocation.events.return();
      expect(h.finishLifecycle).toHaveBeenCalledTimes(
        outcome === 'done' ? 1 : 0,
      );
      expect(h.failLifecycle).toHaveBeenCalledTimes(
        outcome === 'error' ? 1 : 0,
      );
      if (outcome === 'error') {
        expect(h.failLifecycle).toHaveBeenCalledWith(
          TARGET,
          'Original failure',
          expect.any(String),
        );
      }
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it('validates an external binding from a durable workload spec', () => {
    expect(
      externalBindingFromWorkloadSpec({
        binding: { profileId: 'profile-a', alias: 'Researcher' },
      }),
    ).toEqual({
      kind: 'external',
      profileId: 'profile-a',
      alias: 'Researcher',
    });

    expect(externalBindingFromWorkloadSpec({ binding: {} })).toBeNull();
  });

  it('reads built-in Space Prompt snapshots without inferring from ACP preambles', () => {
    expect(
      spacePromptFromWorkloadSpec({
        hostContext: {
          spacePrompt: '<space_prompt>Internal</space_prompt>',
        },
      }),
    ).toBe('<space_prompt>Internal</space_prompt>');
    expect(
      spacePromptFromWorkloadSpec({
        initialPreamble: [
          'Bootstrap',
          '<space_prompt>External</space_prompt>',
          'Node constraints',
        ],
      }),
    ).toBeUndefined();
    expect(
      spacePromptFromWorkloadSpec({ initialPreamble: ['Bootstrap'] }),
    ).toBeUndefined();
  });

  it('resolves a persisted external Thread without a fixed Agent Node', async () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-selectable',
      alias: 'Selectable Agent',
    };
    const harness = createHarness({ target: null, persistedBinding: binding });

    await expect(
      harness.service.resolveExternalTarget('canvas-a', 'thread-a'),
    ).resolves.toEqual({ binding, fixedTarget: null });
  });

  it('prefers the fixed Agent Node binding when one exists', async () => {
    const harness = createHarness({
      persistedBinding: {
        kind: 'external',
        profileId: 'profile-record',
        alias: 'Recorded Agent',
      },
    });

    await expect(
      harness.service.resolveExternalTarget('canvas-a', 'thread-a'),
    ).resolves.toEqual({ binding: TARGET.agentBinding, fixedTarget: TARGET });
  });

  it('uses persisted fixed binding and overrides under one leased lifecycle', async () => {
    const harness = createHarness();
    const invocation = await harness.service.invoke(invocationOptions());

    expect(harness.startLifecycle).toHaveBeenCalledWith(
      TARGET,
      'Investigate this',
      expect.any(String),
    );
    expect(harness.runExternal).not.toHaveBeenCalled();

    const emitted: AgentStreamEvent[] = [];
    for await (const event of invocation.events) emitted.push(event);

    expect(invocation.binding).toEqual(TARGET.agentBinding);
    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'done']);
    expect(harness.runExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.any(Object),
        binding: TARGET.agentBinding,
      }),
    );
    expect(harness.realizeExternal).toHaveBeenCalledWith(
      expect.objectContaining({ requestedCwd: '/task/work' }),
    );
    expect(harness.finishLifecycle).toHaveBeenCalledWith(
      TARGET,
      expect.any(String),
    );
    expect(harness.failLifecycle).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('passes a structured submission to the external Agent handle', async () => {
    const harness = createHarness();
    const submission = createInteractiveViewSubmission({
      protocolVersion: 1,
      nodeId: 'node-view',
      actionId: 'approve-plan',
      input: { approved: true },
      viewRevision: 'view-rev',
    });
    const invocation = await harness.service.invokeSubmission({
      ...invocationOptions(),
      submission,
    });

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.runExternal).toHaveBeenCalledWith(
      expect.objectContaining({ submission }),
    );
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
      expect.any(String),
    );
    expect(harness.finishLifecycle).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('applies persisted initial instructions to a Huabu Agent', async () => {
    const target: FixedAgentNodeTarget = {
      ...TARGET,
      agentBinding: { kind: 'internal' },
      launchOverrides: {
        additionalInitialPreamble: 'Review before making changes.',
      },
    };
    const harness = createHarness({ target });
    const invocation = await harness.service.invoke({
      ...invocationOptions(),
      fixedTarget: target,
      requestBinding: { kind: 'internal' },
    });

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.runInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          systemPrompt: expect.stringContaining(
            'Review before making changes.',
          ),
        }),
        spacePrompt: 'Space prompt',
      }),
    );
  });

  it('collects a Space Prompt for a selectable built-in Agent Node', async () => {
    const harness = createHarness({
      agentTarget: SELECTABLE_TARGET,
      target: null,
    });
    const invocation = await harness.service.invoke({
      ...invocationOptions(),
      requestBinding: { kind: 'internal' },
      agentTarget: SELECTABLE_TARGET,
      fixedTarget: null,
    });

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.collectSpacePrompt).toHaveBeenCalledWith(
      'canvas-a',
      SELECTABLE_TARGET.nodeId,
    );
    expect(harness.runInternal).toHaveBeenCalledWith(
      expect.objectContaining({ spacePrompt: 'Space prompt' }),
    );
    expect(harness.startLifecycle).toHaveBeenCalledWith(
      SELECTABLE_TARGET,
      'Investigate this',
      expect.any(String),
    );
  });

  it('passes a selectable Agent Node to external realization', async () => {
    const harness = createHarness({
      agentTarget: SELECTABLE_TARGET,
      target: null,
    });
    const invocation = await harness.service.invoke({
      ...invocationOptions(),
      agentTarget: SELECTABLE_TARGET,
      fixedTarget: null,
    });

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.realizeExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTarget: SELECTABLE_TARGET,
        fixedTarget: null,
      }),
    );
    expect(harness.startLifecycle).toHaveBeenCalledWith(
      SELECTABLE_TARGET,
      'Investigate this',
      expect.any(String),
    );
  });

  it('does not collect a Space Prompt for a node-less thread', async () => {
    const harness = createHarness({ agentTarget: null, target: null });
    const invocation = await harness.service.invoke({
      ...invocationOptions(),
      requestBinding: { kind: 'internal' },
      agentTarget: null,
      fixedTarget: null,
    });

    for await (const _event of invocation.events) {
      // Drain the canonical invocation stream.
    }

    expect(harness.collectSpacePrompt).not.toHaveBeenCalled();
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
      expect.any(String),
    );
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('exposes explicit stop for any invocation path', async () => {
    const harness = createHarness();
    const invocation = await harness.service.invoke(invocationOptions());

    expect(harness.service.stop('thread-a')).toBe(true);
    expect(invocation.signal.aborted).toBe(true);
    expect(harness.service.stop('thread-a')).toBe(false);
    await invocation.dispose();
  });

  it('registers before lifecycle start and exposes durable turn readiness', async () => {
    const startLifecycle = vi.fn(async () => {
      expect(service.isActive('thread-a', 'canvas-a')).toBe(true);
    });
    const runExternal = vi.fn((runOptions: { onTurnStarted?: () => void }) => {
      runOptions.onTurnStarted?.();
      return events([{ type: 'done', data: { message: 'Done' } }]);
    });
    const service = new AgentThreadService({
      resolveAgentNode: async () => TARGET,
      resolveFixedAgentNode: async () => TARGET,
      resolvePersistedExternalBinding: () => null,
      resolvePersistedSpacePrompt: () => ({ realised: false }),
      collectSpacePrompt: vi.fn().mockResolvedValue(undefined),
      realizeExternal: vi.fn().mockResolvedValue({
        binding: TARGET.agentBinding,
        fixedTarget: TARGET,
        spec: {} as AcpWorkloadSpec,
        handle: {} as AcpHandle,
      }),
      waitForTurnRelease: vi.fn().mockResolvedValue(undefined),
      acquireTurn: vi.fn(() => vi.fn()),
      startLifecycle,
      finishLifecycle: vi.fn().mockResolvedValue(undefined),
      failLifecycle: vi.fn().mockResolvedValue(undefined),
      runExternal,
      runInternal: vi.fn(),
      closeHandle: vi.fn(),
    });

    const invocation = await service.invoke(invocationOptions());
    expect(service.isActive('thread-a', 'canvas-b')).toBe(false);
    let readinessSettled = false;
    void service.waitForTurnStart('thread-a', 'canvas-a').then(() => {
      readinessSettled = true;
    });
    await Promise.resolve();
    expect(readinessSettled).toBe(false);

    const iterator = invocation.events[Symbol.asyncIterator]();
    await iterator.next();

    await expect(
      service.waitForTurnStart('thread-a', 'canvas-a'),
    ).resolves.toBe(true);
    await iterator.next();
    expect(service.isActive('thread-a', 'canvas-a')).toBe(false);
  });

  it('settles readiness as false when disposed before dispatch starts', async () => {
    const harness = createHarness();
    const invocation = await harness.service.invoke(invocationOptions());
    const readiness = harness.service.waitForTurnStart('thread-a', 'canvas-a');

    await invocation.dispose(new Error('SSE setup failed'));

    await expect(readiness).resolves.toBe(false);
    expect(harness.service.isActive('thread-a', 'canvas-a')).toBe(false);
  });
});
