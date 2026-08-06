import { describe, expect, it, vi } from 'vitest';

import { piDriverFactory } from './driver.js';
import {
  lowerPiInputs,
  resolvePiInitialMessages,
  resolvePiSystemPrompt,
} from './handle.js';

import type { PiDriverPorts, PiDurableState, PiWorkloadSpec } from './types.js';
import type { AgentTurn } from '@agenetes/protocol';
import type { HistoryLoadDeniedError } from '@agenetes/runtime';
import type { AgentCreateContext, MountedAgentDriver } from '@agenetes/runtime';

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

const basePorts: PiDriverPorts = {
  resolveModel: vi.fn(),
  getApiKey: vi.fn(),
  resolveTools: vi.fn(),
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
      resolvePiInitialMessages(spec, basePorts, {
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
      basePorts,
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

  it('replays the host-materialized payload and authorizes its reported size', async () => {
    const authorizeHistoryLoad = vi.fn(async () => ({
      allowed: true as const,
      estimatedSize: 7,
    }));
    const materialized = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'hello' },
          {
            type: 'image' as const,
            data: 'aGVsbG8=',
            mimeType: 'image/png',
          },
        ],
        timestamp: 1,
      },
      { role: 'assistant' as const, content: 'world', timestamp: 2 },
    ];
    const materializeHistory = vi.fn(async () => ({
      messages: materialized,
      estimatedSize: 7,
    }));

    const messages = await resolvePiInitialMessages(
      spec,
      { ...basePorts, materializeHistory },
      context(authorizeHistoryLoad),
    );

    expect(materializeHistory).toHaveBeenCalledWith(
      { mode: 'recover', turns: [foldedTurn] },
      expect.objectContaining({ threadId: 'thread_1' }),
    );
    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'recover',
      turns: [foldedTurn],
      estimatedSize: 7,
    });
    expect(messages).toEqual(materialized);
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
      basePorts,
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
      resolvePiInitialMessages(spec, basePorts, context(authorizeHistoryLoad)),
    ).rejects.toMatchObject<HistoryLoadDeniedError>({
      name: 'HistoryLoadDeniedError',
      code: 'safe_limit_exceeded',
      estimatedSize: 20_000,
      safeLimit: 10_000,
    });
  });
});

describe('pi per-thread selection', () => {
  // A reasoning-capable model (no thinkingLevelMap ⇒ supports up to 'high').
  const ports = {
    resolveModel: vi.fn(async () => ({ id: 'resolved', reasoning: true })),
    getApiKey: vi.fn(),
    resolveTools: vi.fn(async () => []),
  } as never;

  it('validates the extended durable state, rejecting unknown keys', () => {
    const driver = piDriverFactory({ ports });
    expect(
      driver.validateState({ modelId: 'gpt-x', reasoningEffort: 'high' }),
    ).toEqual({ modelId: 'gpt-x', reasoningEffort: 'high' });
    expect(driver.validateState({})).toEqual({});
    expect(() => driver.validateState({ bogus: true })).toThrowError(
      expect.objectContaining({ code: 'invalid_driver_state' }),
    );
  });

  it('seeds the selection from recovered driver state', async () => {
    const driver = piDriverFactory({ ports });
    const handle = driver.create(spec, {
      recovery: { authorizeHistoryLoad: vi.fn() },
      recoveryInput: {
        state: { driverState: { modelId: 'gpt-seed', reasoningEffort: 'low' } },
        turns: [],
      },
    });
    const snapshots: unknown[] = [];
    handle.onState?.((s) => snapshots.push(s));

    // A no-op control that still triggers a report would be ideal, but the
    // seed is observable via the first mutation preserving the other field.
    await handle.control({ type: 'set_model', data: { modelId: 'gpt-next' } });
    expect(snapshots.at(-1)).toMatchObject({
      driverState: { modelId: 'gpt-next', reasoningEffort: 'low' },
    });
  });

  it('applies set_model / set_config_option and up-reports the snapshot', async () => {
    const driver = piDriverFactory({ ports });
    const handle = driver.create(spec, {
      recovery: { authorizeHistoryLoad: vi.fn() },
    });
    const snapshots: {
      driverState: unknown;
      metadata?: { currentModelId?: string | null };
    }[] = [];
    const unsub = handle.onState?.((s) => snapshots.push(s));

    expect(
      (await handle.control({ type: 'set_model', data: { modelId: 'gpt-x' } }))
        .ok,
    ).toBe(true);
    expect(
      (
        await handle.control({
          type: 'set_config_option',
          data: { optionId: 'reasoning_effort', value: 'high' },
        })
      ).ok,
    ).toBe(true);

    expect(snapshots.at(-1)?.driverState).toEqual({
      modelId: 'gpt-x',
      reasoningEffort: 'high',
    });
    expect(snapshots.at(-1)?.metadata?.currentModelId).toBe('gpt-x');

    const unknown = await handle.control({
      type: 'set_config_option',
      data: { optionId: 'nope', value: 'x' },
    });
    expect(unknown).toMatchObject({ ok: false, code: 'unsupported' });
    unsub?.();
  });

  it('gates the selection control ops behind Deployment capability', async () => {
    const driver = piDriverFactory({ ports });
    const jobHandle = driver.create(
      { ...spec, workloadType: 'Job' },
      { recovery: { authorizeHistoryLoad: vi.fn() } },
    );
    expect(
      await jobHandle.control({ type: 'set_model', data: { modelId: 'x' } }),
    ).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('drops the reasoning effort when switching to a non-reasoning model', async () => {
    const driver = piDriverFactory({
      ports: {
        resolveModel: vi.fn(async () => ({ id: 'plain', reasoning: false })),
        getApiKey: vi.fn(),
        resolveTools: vi.fn(async () => []),
      } as never,
    });
    const handle = driver.create(spec, {
      recovery: { authorizeHistoryLoad: vi.fn() },
      recoveryInput: {
        state: { driverState: { modelId: 'gpt-r', reasoningEffort: 'high' } },
        turns: [],
      },
    });
    const snapshots: { driverState: { reasoningEffort?: string } }[] = [];
    handle.onState?.((s) => snapshots.push(s as never));
    await handle.control({ type: 'set_model', data: { modelId: 'plain' } });
    // 'high' is incompatible with a non-reasoning model → dropped.
    expect(snapshots.at(-1)?.driverState).toEqual({ modelId: 'plain' });
  });

  it('clamps an unsupported effort to the nearest supported level', async () => {
    // The shared reasoning mock supports up to 'high' (no xhigh/max).
    const driver = piDriverFactory({ ports });
    const handle = driver.create(spec, {
      recovery: { authorizeHistoryLoad: vi.fn() },
      recoveryInput: {
        state: { driverState: { modelId: 'm', reasoningEffort: 'xhigh' } },
        turns: [],
      },
    });
    const snapshots: { driverState: { reasoningEffort?: string } }[] = [];
    handle.onState?.((s) => snapshots.push(s as never));
    await handle.control({ type: 'set_model', data: { modelId: 'm2' } });
    expect(snapshots.at(-1)?.driverState.reasoningEffort).toBe('high');
  });
});
