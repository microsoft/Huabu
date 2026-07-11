import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyAcpOverlay } from './overlay.js';
import { AcpServiceError } from './errors.js';

import type { AcpSessionEntry } from './session-registry.js';
import type { AgentCreateContext } from '@agenetes/runtime';
import type { AcpCreateSpec, PreparedAcpPrompt } from './handle.js';

const sessionMocks = vi.hoisted(() => ({
  ensureAcpSession: vi.fn(),
  registerAcpStateListener: vi.fn(() => () => {}),
  reportEntryState: vi.fn(),
}));

vi.mock('./session.js', () => sessionMocks);

import { AcpAgentHandle } from './handle.js';

const spec: AcpCreateSpec = {
  threadId: 'thread_1',
  namespace: { name: 'canvas_1' },
  binding: { alias: 'copilot', profileId: 'profile_1' },
  recipe: {
    alias: 'copilot',
    command: 'copilot --acp',
    cwd: '/repo',
  },
};

const foldedTurn = {
  request: { type: 'user_text' as const, content: 'earlier question' },
  transcript: [{ type: 'text' as const, data: { content: 'earlier answer' } }],
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function durableContext(
  authorizeHistoryLoad: AgentCreateContext<AcpCreateSpec>['recovery']['authorizeHistoryLoad'],
): AgentCreateContext<AcpCreateSpec> {
  return {
    durableInput: {
      source: { namespace: spec.namespace, threadId: spec.threadId },
      record: {
        spec,
        state: {
          sessionId: 'stale_session',
          metadata: { currentModeId: 'ask' },
        },
      },
      turns: [foldedTurn],
    },
    recovery: { authorizeHistoryLoad },
  };
}

function sessionEntry() {
  const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
  return {
    entry: {
      client: { prompt },
      sessionId: 'fresh_session',
      profileId: 'profile_1',
      namespace: spec.namespace,
      systemPreambleSent: false,
      persistedToDisk: false,
    } as unknown as AcpSessionEntry,
    prompt,
  };
}

const render = vi.fn(
  async (): Promise<PreparedAcpPrompt> => ({
    serialized: 'current request',
    includedSystem: true,
    blocks: [{ type: 'text', text: 'current request' }],
  }),
);

describe('ACP durable history recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back only from structured native-resume unavailability', async () => {
    const authorizeHistoryLoad = vi.fn(async () => ({
      allowed: true as const,
      estimatedSize: 100,
    }));
    const { entry, prompt } = sessionEntry();
    sessionMocks.ensureAcpSession
      .mockRejectedValueOnce(
        new AcpServiceError(
          'session_resume_unavailable',
          'native session is gone',
        ),
      )
      .mockResolvedValueOnce(entry);

    const handle = new AcpAgentHandle(
      spec,
      durableContext(authorizeHistoryLoad),
    );
    for await (const _event of handle.run({ text: 'current' }, render, {
      overlay: emptyAcpOverlay(),
      logger,
    })) {
      // Drain the turn.
    }

    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledTimes(2);
    expect(sessionMocks.ensureAcpSession.mock.calls[0]?.[0]).toMatchObject({
      priorState: { sessionId: 'stale_session' },
    });
    expect(sessionMocks.ensureAcpSession.mock.calls[1]?.[0]).toMatchObject({
      priorState: { metadata: { currentModeId: 'ask' } },
    });
    expect(
      sessionMocks.ensureAcpSession.mock.calls[1]?.[0]?.priorState,
    ).not.toHaveProperty('sessionId');
    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'recover',
      turns: [foldedTurn],
    });
    expect(prompt.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(JSON.stringify(foldedTurn)),
      }),
      { type: 'text', text: 'current request' },
    ]);
  });

  it('keeps unrelated spawn failures hard', async () => {
    const authorizeHistoryLoad = vi.fn();
    sessionMocks.ensureAcpSession.mockRejectedValueOnce(
      new AcpServiceError('spawn_failed', 'worker rejected spawn'),
    );
    const handle = new AcpAgentHandle(
      spec,
      durableContext(authorizeHistoryLoad),
    );

    await expect(
      handle
        .run({ text: 'current' }, render, {
          overlay: emptyAcpOverlay(),
          logger,
        })
        .next(),
    ).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledTimes(1);
    expect(authorizeHistoryLoad).not.toHaveBeenCalled();
  });
});
