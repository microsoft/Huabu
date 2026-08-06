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

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// The output tail the fake Agent appends to its transcript on
// `prompt()` / `continue()`.
let mockOutputTail: Array<Record<string, unknown>> = [];

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
  resolveModelForRoleAsync: () => Promise.resolve({ id: 'mock-model' }),
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

import { runAgent, syncDeploymentSystemPrompt } from './agent.service.js';

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

// A minimal envelope — its content is irrelevant here because the render
// is mocked; presence alone selects the delta-slice branch.
const ENVELOPE = {} as ChatEnvelope;

beforeEach(() => {
  mockOutputTail = [{ ...ASSISTANT_REPLY }];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runAgent output delta', () => {
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
