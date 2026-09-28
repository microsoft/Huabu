// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Output-delta tests for {@link runAgent} (single-channel dispatch).
 *
 * `runAgent` renders THIS turn's envelope into its user message and runs
 * the built-in agent over `[prior history + this turn]`. The prior history
 * seeds the injected `Agent`; this turn's rendered message is appended by
 * the handle via `agent.prompt(...)`. The invariant under test: the run
 * delivers its output ONLY via the generator's RETURN value (the messages
 * the agent appended); `context.messages` is read-only INPUT and is never
 * mutated. The rendered user message is kept OUT of the returned delta (it
 * is re-derived from the envelope on reload).
 *
 * The envelope-less callers (memory analyzer / sketch / reachback) submit
 * a null request; the handle runs over `context.messages` as-is via
 * `agent.continue()` and likewise receives the delta via the return value.
 *
 * pi-agent-core's `Agent` is mocked to a deterministic fake that appends
 * a configurable output tail and emits a single `agent_end`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { agentTurnAcceptedSchema } from '@huabu/shared';

const { resolveModelForRoleAsync, resolveModelByIdAsync } = vi.hoisted(() => ({
  resolveModelForRoleAsync: vi.fn(),
  resolveModelByIdAsync: vi.fn(),
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

// The output tail the fake Agent appends to its transcript on
// `prompt()` / `continue()`.
let mockOutputTail: Array<Record<string, unknown>> = [];
let mockPromptWait: Promise<void> | undefined;

vi.mock('@earendil-works/pi-agent-core', () => {
  class FakeAgent {
    state: { messages: Array<Record<string, unknown>>; errorMessage?: string };
    private cb?: (event: Record<string, unknown>) => void;

    constructor(opts: {
      initialState: { messages: Array<Record<string, unknown>> };
    }) {
      // Mirror the real setter: copy the array, keep element identities.
      this.state = { messages: [...opts.initialState.messages] };
    }

    subscribe(cb: (event: Record<string, unknown>) => void): () => void {
      this.cb = cb;
      return () => {
        this.cb = undefined;
      };
    }

    async continue(): Promise<void> {
      this.state.messages.push(...mockOutputTail);
      this.cb?.({ type: 'agent_end' });
    }

    async prompt(
      message: Record<string, unknown> | Array<Record<string, unknown>>,
    ): Promise<void> {
      // Mirror the real `prompt`: append this turn's message(s), then run
      // (which appends the output tail) and emit `agent_end`.
      const turn = Array.isArray(message) ? message : [message];
      this.state.messages.push(...turn);
      await mockPromptWait;
      this.state.messages.push(...mockOutputTail);
      this.cb?.({ type: 'agent_end' });
    }

    abort(): void {}
    async waitForIdle(): Promise<void> {}
  }

  return {
    Agent: FakeAgent,
    // Identity downcast: our fake transcript is already LLM-shaped.
    convertToLlm: (msgs: unknown) => msgs,
  };
});

vi.mock('./llm.js', () => ({
  getLLMModel: () => ({ id: 'mock-model' }),
  ensureApiKey: () => 'mock-key',
  resolveModelForRoleAsync,
  resolveModelByIdAsync,
  ensureApiKeyForRole: () => 'mock-key',
}));

vi.mock('./tools/index.js', () => ({
  buildToolsForScope: () => [],
  buildAgentToolsByNames: () => [],
}));

// Deterministic per-turn render: one user message, no canvas / I/O.
vi.mock('./conversation/prompt/build-prompt.js', () => ({
  renderInternalAgentInputs: vi.fn(async () => [
    { type: 'text', text: 'TURN_USER_MESSAGE' },
  ]),
  agentInputsToPiMessages: vi.fn(() => [
    { role: 'user', content: 'TURN_USER_MESSAGE', timestamp: 1 },
  ]),
}));

import { setWorkspacePath } from '../workspace.js';
import { conversationEventLogStore } from './agenetes/conversation-stores.js';
import { agenetes } from './agenetes/drivers.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import { runAgent, syncDeploymentSystemPrompt } from './agent.service.js';
import { InkVisualPreparationError } from './conversation/envelope.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { renderInternalAgentInputs } from './conversation/prompt/build-prompt.js';

import type { BuiltinHandle } from './agenetes/drivers.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { Context, Message } from '@earendil-works/pi-ai';

// ─── Helpers ────────────────────────────────────────────────────────

/** Drain the generator, returning its RETURN value (the output delta). */
async function drain(
  gen: AsyncGenerator<unknown, unknown, unknown>,
): Promise<Message[]> {
  const it = gen[Symbol.asyncIterator]();
  while (true) {
    const { value, done } = await it.next();
    if (done) return (value ?? []) as Message[];
  }
}

function priorContext(messages: Array<Record<string, unknown>>): Context {
  return {
    systemPrompt: 'SYS',
    messages,
  } as unknown as Context;
}

const ASSISTANT_REPLY = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'end_turn',
  timestamp: 2,
};

// A minimal envelope — its rendered content is mocked, but main's title
// initialization still reads the canonical user text.
const ENVELOPE: ChatEnvelope = {
  user: { text: 'TURN_USER_MESSAGE', attachments: [] },
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

beforeEach(() => {
  const workspacePath = process.env.HUABU_DATA_DIR;
  if (!workspacePath) throw new Error('Missing isolated test data directory');
  setWorkspacePath(workspacePath);
  mockOutputTail = [{ ...ASSISTANT_REPLY }];
  mockPromptWait = undefined;
  resolveModelForRoleAsync.mockReset().mockResolvedValue({
    id: 'default-text',
    input: ['text'],
  });
  resolveModelByIdAsync
    .mockReset()
    .mockImplementation(async (modelId: string) => ({
      id: modelId,
      input: modelId === 'vision' ? ['text', 'image'] : ['text'],
    }));
});

afterEach(() => vi.restoreAllMocks());

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runAgent output delta', () => {
  it.each(['Job', 'Deployment'] as const)(
    'awaits the %s binding confirmation before controls or run',
    async (workloadType) => {
      const order: string[] = [];
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const enteredConfirmation = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const control = vi.fn(async () => {
        order.push('control');
        return { ok: true };
      });
      const run = vi.fn(() => {
        order.push('run');
        return (async function* () {
          yield* [];
          return [];
        })();
      });
      const create = vi.spyOn(agenetes, 'create').mockImplementation(() => {
        order.push('create');
        return { control, run } as unknown as ReturnType<
          typeof agenetes.create
        >;
      });
      try {
        const pending = drain(
          runAgent({
            scope: 'ask',
            context: priorContext([]),
            threadId: `binding-seam-${workloadType}`,
            workloadType,
            modelId: 'chosen-model',
            onExecutionCreated: async () => {
              order.push('confirm');
              entered();
              await ready;
              order.push('bound');
            },
          }),
        );
        await enteredConfirmation;
        expect(order).toEqual(['create', 'confirm']);
        expect(control).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        release();
        await pending;
        expect(order).toEqual(
          workloadType === 'Job'
            ? ['create', 'confirm', 'bound', 'run']
            : ['create', 'confirm', 'bound', 'control', 'run'],
        );
      } finally {
        create.mockRestore();
      }
    },
  );

  it('does not dispatch when cancellation arrives during binding confirmation', async () => {
    const controller = new AbortController();
    const onTurnStarted = vi.fn();
    await drain(
      runAgent({
        scope: 'ask',
        context: priorContext([]),
        signal: controller.signal,
        onTurnStarted,
        onExecutionCreated: async () => {
          controller.abort();
        },
      }),
    );
    expect(onTurnStarted).not.toHaveBeenCalled();
  });

  it('surfaces binding projection failure before prompt dispatch', async () => {
    const onTurnStarted = vi.fn();
    await expect(
      drain(
        runAgent({
          scope: 'ask',
          context: priorContext([]),
          onTurnStarted,
          onExecutionCreated: async () => {
            throw new Error('Bound write failed');
          },
        }),
      ),
    ).rejects.toThrow('Bound write failed');
    expect(onTurnStarted).not.toHaveBeenCalled();
  });

  it('provides the persisted turn-start identity while the model is still pending', async () => {
    const threadId = 'acceptance-pending';
    const canvasId = 'acceptance-canvas';
    const namespace = canvasAcpNamespace(canvasId);
    let releasePrompt!: () => void;
    mockPromptWait = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const onTurnStarted = vi.fn(() => notifyStarted());
    const iterator = runAgent({
      scope: 'ask',
      context: priorContext([]),
      envelope: ENVELOPE,
      workloadType: 'Deployment',
      threadId,
      canvasId,
      onTurnStarted,
    });
    let settled = false;
    const output = drain(iterator).finally(() => {
      settled = true;
    });
    try {
      await Promise.race([started, output]);
      expect(settled).toBe(false);
      expect((await agenetes.logMetadata(namespace, threadId)).eventCount).toBe(
        1,
      );
      expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
        threadId,
        turnStartSeq: 1,
      });
    } finally {
      releasePrompt();
      await output;
      await agenetes.close(threadId);
    }
  });

  it('with an envelope: returns only the output delta, excluding the rendered user message', async () => {
    const prior = [
      { role: 'user', content: 'earlier question', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier' }],
        timestamp: 0,
      },
    ];
    const context = priorContext([...prior]);

    const output = await drain(
      runAgent({
        scope: 'ask',
        context,
        envelope: ENVELOPE,
      }),
    );

    // `context.messages` is read-only input — unchanged (prior history only).
    expect(context.messages).toHaveLength(2);
    // The return value is ONLY the output delta (assistant reply); the
    // rendered 'TURN_USER_MESSAGE' is excluded.
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ role: 'assistant' });
    expect(JSON.stringify(output)).not.toContain('TURN_USER_MESSAGE');
  });

  it('with no envelope (legacy callers): returns the appended output, leaving context untouched', async () => {
    const context = priorContext([
      { role: 'user', content: 'analyze this', timestamp: 0 },
    ]);

    const output = await drain(
      runAgent({
        scope: 'ask',
        context,
        // No envelope → legacy path: run over context.messages as-is.
      }),
    );

    // Input context is untouched (the caller-built message stays as-is).
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ content: 'analyze this' });
    // Output delta = the appended assistant reply.
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ role: 'assistant' });
  });
});

describe('runAgent Ink model requirements', () => {
  it.each([false, true])(
    'uses a persisted vision selection (recover: %s)',
    async (recover) => {
      const canvasId = 'ink-models';
      const threadId = `persisted-vision-${recover}`;
      const namespace = canvasAcpNamespace(canvasId);
      const handle = await agenetes.create(
        buildHuabuPiWorkloadSpec({
          kind: 'internal',
          workloadType: 'Deployment',
          namespace,
          threadId,
          toolNames: [],
        }),
      );
      await handle.control({ type: 'set_model', data: { modelId: 'vision' } });
      if (recover) await agenetes.close(threadId);
      resolveModelByIdAsync.mockClear();
      const onTurnStarted = vi.fn();
      try {
        await drain(
          runAgent({
            scope: 'operate',
            canvasId,
            threadId,
            workloadType: 'Deployment',
            context: priorContext([]),
            envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
            onTurnStarted,
          }),
        );
        expect(resolveModelByIdAsync).toHaveBeenCalledWith('vision');
        expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
          threadId,
          turnStartSeq: 1,
        });
      } finally {
        await agenetes.close(threadId);
      }
    },
  );

  it('checks the persisted workload model context rather than the incoming hints', async () => {
    const canvasId = 'ink-models';
    const threadId = 'persisted-model-context';
    const namespace = canvasAcpNamespace(canvasId);
    await agenetes.create(
      buildHuabuPiWorkloadSpec({
        kind: 'internal',
        workloadType: 'Deployment',
        namespace,
        threadId,
        toolNames: [],
        modelRole: 'chat',
        hasImage: false,
      }),
    );
    await agenetes.close(threadId);
    resolveModelForRoleAsync.mockImplementation(async (role: string) => ({
      id: role,
      input: role === 'chat' ? ['text'] : ['text', 'image'],
    }));
    const onTurnStarted = vi.fn();
    await expect(
      drain(
        runAgent({
          scope: 'operate',
          canvasId,
          threadId,
          workloadType: 'Deployment',
          context: priorContext([]),
          envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
          modelRole: 'skill',
          hasImage: true,
          onTurnStarted,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ink_model_unsupported', modelId: 'chat' });
    expect(resolveModelForRoleAsync).toHaveBeenCalledWith('chat', {
      hasImage: false,
    });
    expect(onTurnStarted).not.toHaveBeenCalled();
  });

  it('accepts the default image-capable model without applying a model override', async () => {
    resolveModelForRoleAsync.mockResolvedValue({
      id: 'default-vision',
      input: ['text', 'image'],
    });
    const threadId = 'default-vision';
    const canvasId = 'ink-models';
    const onTurnStarted = vi.fn();
    try {
      await drain(
        runAgent({
          scope: 'ask',
          canvasId,
          threadId,
          workloadType: 'Deployment',
          context: priorContext([]),
          envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
          onTurnStarted,
        }),
      );
      expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
        threadId,
        turnStartSeq: 1,
      });
      expect(resolveModelByIdAsync).not.toHaveBeenCalled();
      expect(
        (await agenetes.record(canvasAcpNamespace(canvasId), threadId))?.state
          .driverState,
      ).not.toHaveProperty('modelId');
    } finally {
      await agenetes.close(threadId);
    }
  });

  it('does not run or accept if applying the selected model is rejected', async () => {
    const run = vi.fn();
    const handle = {
      run,
      control: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'model rejected' }),
    } as unknown as BuiltinHandle;
    vi.spyOn(agenetes, 'create').mockResolvedValue(handle);
    const onTurnStarted = vi.fn();
    await expect(
      drain(
        runAgent({
          scope: 'ask',
          canvasId: 'ink-models',
          threadId: 'rejected-model-control',
          workloadType: 'Deployment',
          context: priorContext([]),
          envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
          modelId: 'vision',
          onTurnStarted,
        }),
      ),
    ).rejects.toThrow('Failed to apply thread model: model rejected');
    expect(run).not.toHaveBeenCalled();
    expect(onTurnStarted).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'default', scope: 'ask', recover: false },
    { source: 'default', scope: 'operate', recover: false },
    { source: 'request', scope: 'operate', recover: false },
    { source: 'persisted', scope: 'ask', recover: false },
    { source: 'persisted', scope: 'operate', recover: true },
  ] as const)(
    'rejects a text-only $source model in $scope (recover: $recover) before persistence',
    async ({ source, scope, recover }) => {
      const canvasId = 'ink-models';
      const threadId = `${source}-${scope}-${recover}`;
      const namespace = canvasAcpNamespace(canvasId);
      if (source === 'persisted') {
        const handle = await agenetes.create(
          buildHuabuPiWorkloadSpec({
            kind: 'internal',
            workloadType: 'Deployment',
            namespace,
            threadId,
            toolNames: [],
            modelRole: 'chat',
          }),
        );
        await handle.control({
          type: 'set_model',
          data: { modelId: 'stored-text' },
        });
        if (recover) await agenetes.close(threadId);
        resolveModelByIdAsync.mockClear();
        resolveModelForRoleAsync.mockResolvedValue({
          id: 'default-vision',
          input: ['text', 'image'],
        });
      }
      const onTurnStarted = vi.fn();
      try {
        await expect(
          drain(
            runAgent({
              scope,
              canvasId,
              threadId,
              workloadType: 'Deployment',
              context: priorContext([]),
              envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
              modelId: source === 'request' ? 'chosen-text' : undefined,
              onTurnStarted,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'ink_model_unsupported',
          modelId:
            source === 'default'
              ? 'default-text'
              : source === 'request'
                ? 'chosen-text'
                : 'stored-text',
        });
        expect(onTurnStarted).not.toHaveBeenCalled();
        expect(
          (await agenetes.logMetadata(namespace, threadId)).eventCount,
        ).toBe(0);
        if (source === 'persisted') {
          expect(resolveModelByIdAsync).toHaveBeenCalledWith('stored-text');
        }
      } finally {
        await agenetes.close(threadId);
      }
    },
  );

  it('accepts the requested vision override without switching to the default text model', async () => {
    const threadId = 'ink-vision-request';
    const canvasId = 'ink-models';
    const onTurnStarted = vi.fn();
    try {
      await drain(
        runAgent({
          scope: 'ask',
          canvasId,
          threadId,
          workloadType: 'Deployment',
          context: priorContext([]),
          envelope: { user: { inputKind: 'ink-intent' } } as ChatEnvelope,
          modelId: 'vision',
          onTurnStarted,
        }),
      );
      expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
        threadId,
        turnStartSeq: 1,
      });
      expect(resolveModelByIdAsync).toHaveBeenCalledWith('vision');
      expect(
        (await agenetes.record(canvasAcpNamespace(canvasId), threadId))?.state
          .driverState,
      ).toMatchObject({ modelId: 'vision' });
    } finally {
      await agenetes.close(threadId);
    }
  });
});

describe('runAgent durable acceptance failures', () => {
  it('validates acceptance identity with the shared Zod schema', () => {
    const identity = { threadId: 'thread-a', turnStartSeq: 3 };
    expect(agentTurnAcceptedSchema.parse(identity)).toEqual(identity);
    for (const data of [
      null,
      {},
      { ...identity, threadId: '' },
      { ...identity, turnStartSeq: 0 },
      { ...identity, turnStartSeq: -1 },
      { ...identity, turnStartSeq: 1.5 },
      { ...identity, turnStartSeq: '3' },
    ]) {
      expect(agentTurnAcceptedSchema.safeParse(data).success).toBe(false);
    }
  });

  it('does not accept a turn when required visual rendering fails', async () => {
    const failure = new InkVisualPreparationError(['sketch-a']);
    vi.mocked(renderInternalAgentInputs).mockRejectedValueOnce(failure);
    const create = vi.spyOn(agenetes, 'create');
    const onTurnStarted = vi.fn();
    await expect(
      drain(
        runAgent({
          scope: 'operate',
          context: priorContext([]),
          envelope: ENVELOPE,
          onTurnStarted,
        }),
      ),
    ).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
    expect(onTurnStarted).not.toHaveBeenCalled();
  });

  it('does not start a durable turn after cancellation wins preparation', async () => {
    const canvasId = 'acceptance-canvas';
    const threadId = 'acceptance-cancelled';
    const controller = new AbortController();
    const onTurnStarted = vi.fn();
    controller.abort();
    try {
      await expect(
        drain(
          runAgent({
            scope: 'ask',
            canvasId,
            threadId,
            workloadType: 'Deployment',
            context: priorContext([]),
            envelope: ENVELOPE,
            signal: controller.signal,
            onTurnStarted,
          }),
        ),
      ).resolves.toEqual([]);
      expect(onTurnStarted).not.toHaveBeenCalled();
      expect(
        (await agenetes.logMetadata(canvasAcpNamespace(canvasId), threadId))
          .eventCount,
      ).toBe(0);
    } finally {
      await agenetes.close(threadId);
    }
  });

  it('does not accept a turn when Tier-1 persistence fails', async () => {
    const failure = new Error('turn-start write failed');
    vi.spyOn(
      conversationEventLogStore,
      'appendTurnStart',
    ).mockImplementationOnce(() => {
      throw failure;
    });
    const threadId = 'acceptance-write-failure';
    const onTurnStarted = vi.fn();
    try {
      await expect(
        drain(
          runAgent({
            scope: 'ask',
            canvasId: 'acceptance-canvas',
            threadId,
            workloadType: 'Deployment',
            context: priorContext([]),
            envelope: ENVELOPE,
            onTurnStarted,
          }),
        ),
      ).rejects.toBe(failure);
      expect(onTurnStarted).not.toHaveBeenCalled();
    } finally {
      await agenetes.close(threadId);
    }
  });

  it('uses the next Tier-1 sequence for a later turn', async () => {
    const canvasId = 'acceptance-canvas';
    const threadId = 'acceptance-later-turn';
    const namespace = canvasAcpNamespace(canvasId);
    const options = {
      scope: 'ask' as const,
      workloadType: 'Deployment' as const,
      canvasId,
      threadId,
      context: priorContext([]),
      envelope: ENVELOPE,
    };
    try {
      await drain(runAgent(options));
      const previousSeq = (await agenetes.logMetadata(namespace, threadId))
        .eventCount;
      const onTurnStarted = vi.fn();
      await drain(runAgent({ ...options, onTurnStarted }));
      expect(onTurnStarted).toHaveBeenCalledExactlyOnceWith({
        threadId,
        turnStartSeq: previousSeq + 1,
      });
    } finally {
      await agenetes.close(threadId);
    }
  });
});

describe('syncDeploymentSystemPrompt', () => {
  it('sends set_context only when a live handle needs a different prompt', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true });
    const handle = { control } as unknown as BuiltinHandle;

    await syncDeploymentSystemPrompt(handle, 'SYS-A', true);
    await syncDeploymentSystemPrompt(handle, 'SYS-A', false);
    expect(control).not.toHaveBeenCalled();

    await syncDeploymentSystemPrompt(handle, 'SYS-B', false);
    await syncDeploymentSystemPrompt(handle, 'SYS-B', false);

    expect(control).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledWith({
      type: 'set_context',
      data: { systemPrompt: 'SYS-B' },
    });
  });

  it('synchronizes a recovered handle before its first turn', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true });
    const handle = { control } as unknown as BuiltinHandle;

    await syncDeploymentSystemPrompt(handle, 'CURRENT-SYS', false);

    expect(control).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledWith({
      type: 'set_context',
      data: { systemPrompt: 'CURRENT-SYS' },
    });
  });
});
