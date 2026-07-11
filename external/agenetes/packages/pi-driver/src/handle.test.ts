import { describe, expect, it, vi } from 'vitest';

import { HistoryLoadDeniedError } from '@agenetes/runtime';

import { resolvePiInitialMessages } from './handle.js';

import type { AgentTurn } from '@agenetes/protocol';
import type { AgentCreateContext } from '@agenetes/runtime';
import type { PiWorkloadSpec } from './types.js';

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
  authorizeHistoryLoad: AgentCreateContext<PiWorkloadSpec>['recovery']['authorizeHistoryLoad'],
  sourceThreadId = spec.threadId,
): AgentCreateContext<PiWorkloadSpec> {
  return {
    durableInput: {
      source: {
        namespace: spec.namespace,
        threadId: sourceThreadId,
      },
      record: { spec, state: {} },
      turns: [foldedTurn],
    },
    recovery: { authorizeHistoryLoad },
  };
}

describe('pi durable history seed', () => {
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
    expect(messages[0]?.content).toContain(JSON.stringify(foldedTurn));
    expect(messages[0]?.content).not.toContain('legacy seed');
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
