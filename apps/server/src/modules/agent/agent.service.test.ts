/**
 * Transcript-sync tests for {@link runAgent} (方案B symmetric dispatch).
 *
 * `runAgent` now renders THIS turn's envelope into its user message
 * internally and runs the agent over `[prior history + this turn]` held
 * in a LOCAL array. The invariant under test: after a run,
 * `context.messages` holds `prior history + this turn's output delta` —
 * the rendered user message is kept OUT (it is re-derived from the
 * envelope on reload, so persisting it would duplicate it).
 *
 * The envelope-less legacy path (memory analyzer / sketch / reachback)
 * keeps the old full-transcript replace.
 *
 * pi-agent-core's `Agent` is mocked to a deterministic fake that appends
 * a configurable output tail and emits a single `agent_end`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// The output tail the fake Agent appends to its transcript on `continue()`.
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
}));

vi.mock('./tools/index.js', () => ({
  buildToolsForScope: () => [],
}));

// Deterministic per-turn render: one user message, no canvas / I/O.
vi.mock('./context/render-turn.js', () => ({
  renderEnvelopeMessages: vi.fn(async () => ({
    messages: [{ role: 'user', content: 'TURN_USER_MESSAGE', timestamp: 1 }],
  })),
}));

import { runAgent } from './agent.service.js';

import type { ChatEnvelope } from './context/envelope.js';
import type { Context } from '@earendil-works/pi-ai';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Drain the generator to completion (we only assert post-run state). */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* discard events */
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

describe('runAgent transcript sync', () => {
  it('with an envelope: appends only the output delta, excluding the rendered user message', async () => {
    const prior = [
      { role: 'user', content: 'earlier question', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier' }],
        timestamp: 0,
      },
    ];
    const context = priorContext([...prior]);

    await drain(
      runAgent({
        scope: 'ask',
        context,
        envelope: ENVELOPE,
      }),
    );

    // prior history (2) + assistant output (1) = 3; the rendered
    // 'TURN_USER_MESSAGE' is NOT persisted into context.messages.
    expect(context.messages).toHaveLength(3);
    expect(context.messages[0]).toMatchObject({ content: 'earlier question' });
    expect(context.messages[2]).toMatchObject({ role: 'assistant' });
    const serialized = JSON.stringify(context.messages);
    expect(serialized).not.toContain('TURN_USER_MESSAGE');
  });

  it('with no envelope (legacy callers): full-transcript replace keeps the user message', async () => {
    const context = priorContext([
      { role: 'user', content: 'analyze this', timestamp: 0 },
    ]);

    await drain(
      runAgent({
        scope: 'ask',
        context,
        // No envelope → legacy path: run over context.messages as-is.
      }),
    );

    // The legacy path syncs the full final transcript: original user
    // message + appended assistant output.
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]).toMatchObject({ content: 'analyze this' });
    expect(context.messages[1]).toMatchObject({ role: 'assistant' });
  });
});
