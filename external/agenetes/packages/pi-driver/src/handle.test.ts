import { describe, expect, it, vi } from 'vitest';

import {
  lowerPiInputs,
  resolvePiInitialMessages,
  resolvePiSystemPrompt,
} from './handle.js';
import { piDriverFactory } from './driver.js';

import type { PiDurableState, PiWorkloadSpec } from './types.js';
import type { AgentTurn } from '@agenetes/protocol';
import type { HistoryLoadDeniedError } from '@agenetes/runtime';
import type {
  AgentCreateContext,
  MountedAgentDriver,
} from '@agenetes/runtime';

const spec: PiWorkloadSpec = {
  kind: 'internal',
  workloadType: 'Deployment',
  namespace: { name: 'canvas_1' },
  threadId: 'thread_1',
  spec: {
    recipe: { model: { type: 'host', id: 'active' } },
    initialMessages: [{ role: 'user', content: 'legacy seed', timestamp: 1 }],
  },
};

const foldedTurn: AgentTurn = {
  request: { type: 'user_text', content: 'hello' },
  transcript: [{ type: 'text', data: { content: 'world' } }],
};

function context(
  authorizeHistoryLoad: AgentCreateContext<PiDurableState>['recovery']['authorizeHistoryLoad'],
  sourceThreadId = spec.threadId,
): AgentCreateContext<PiDurableState> {
  const durableInput =
    sourceThreadId === spec.threadId
      ? {
          recoveryInput: {
            state: { driverState: {} },
            turns: [foldedTurn],
          },
        }
      : {
          forkInput: {
            source: {
              namespace: spec.namespace,
              threadId: sourceThreadId,
            },
            turns: [foldedTurn],
          },
        };
  return {
    ...durableInput,
    recovery: { authorizeHistoryLoad },
  };
}

describe('pi durable history seed', () => {
  it('mounts runtime spec and state validation', () => {
    const driver: MountedAgentDriver = piDriverFactory({
      ports: {
        resolveModel: vi.fn(),
        getApiKey: vi.fn(),
        resolveTools: vi.fn(),
      },
    });

    expect(driver.validateSpec(spec.spec)).toMatchObject({
      recipe: { model: { type: 'host', id: 'active' } },
    });
    expect(driver.initialState()).toEqual({});
    expect(() =>
      driver.validateSpec({
        recipe: { model: { type: 'host', id: '' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_driver_spec' }));
    expect(() => driver.validateState({ unexpected: true })).toThrowError(
      expect.objectContaining({ code: 'invalid_driver_state' }),
    );
  });

  it('keeps configured initial messages for a fresh create', async () => {
    const authorizeHistoryLoad = vi.fn();
    await expect(
      resolvePiInitialMessages(spec, {
        recovery: { authorizeHistoryLoad },
      }),
    ).resolves.toEqual(spec.spec.initialMessages);
    expect(authorizeHistoryLoad).not.toHaveBeenCalled();
  });

  it('authorizes recovery and replaces legacy seed with one JSONL history message', async () => {
    const authorizeHistoryLoad = vi.fn(async () => ({
      allowed: true as const,
      estimatedSize: 42,
    }));
    const messages = await resolvePiInitialMessages(
      spec,
      context(authorizeHistoryLoad),
    );

    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'recover',
      turns: [foldedTurn],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user' });
    expect(messages[0]?.content).toContain(
      '"rendered":[{"type":"text","text":"hello"}]',
    );
    expect(messages[0]?.content).not.toContain('legacy seed');
  });

  describe('pi canonical input lowering', () => {
    it('preserves multiple input members in one atomic prompt payload', () => {
      expect(
        lowerPiInputs([
          { type: 'text', text: 'first' },
          {
            type: 'parts',
            parts: [
              { type: 'text', text: 'second' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ]),
      ).toMatchObject([
        { role: 'user', content: 'first' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'second' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        },
      ]);
    });

    describe('pi initial preamble realization', () => {
      it('maps portable fragments onto the harness-native system prompt', () => {
        expect(
          resolvePiSystemPrompt({
            ...spec,
            spec: {
              ...spec.spec,
              initialPreamble: ['identity', 'tool policy'],
            },
          }),
        ).toBe('identity\n\ntool policy');
        expect(
          resolvePiSystemPrompt({
            ...spec,
            spec: { ...spec.spec, initialPreamble: [] },
          }),
        ).toBe(undefined);
      });
    });
  });

  it('classifies a different source identity as a fork', async () => {
    const authorizeHistoryLoad = vi.fn(async () => ({
      allowed: true as const,
      estimatedSize: 42,
    }));
    await resolvePiInitialMessages(
      spec,
      context(authorizeHistoryLoad, 'source_thread'),
    );
    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'fork',
      turns: [foldedTurn],
    });
  });

  it('surfaces structured policy denial', async () => {
    const authorizeHistoryLoad = vi.fn(async () => ({
      allowed: false as const,
      code: 'safe_limit_exceeded' as const,
      estimatedSize: 20_000,
      safeLimit: 10_000,
    }));
    await expect(
      resolvePiInitialMessages(spec, context(authorizeHistoryLoad)),
    ).rejects.toMatchObject<HistoryLoadDeniedError>({
      name: 'HistoryLoadDeniedError',
      code: 'safe_limit_exceeded',
      estimatedSize: 20_000,
      safeLimit: 10_000,
    });
  });
});
