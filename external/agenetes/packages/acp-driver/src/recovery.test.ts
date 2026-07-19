import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpServiceError } from './errors.js';
import { AcpAgentHandle, lowerAcpInputs } from './handle.js';
import { emptyAcpOverlay } from './overlay.js';

import type { AcpCreateSpec, AcpDurableState } from './handle.js';
import type { AcpSessionEntry } from './session-registry.js';
import type { AgentCreateContext } from '@agenetes/runtime';

const sessionMocks = vi.hoisted(() => ({
  ensureAcpSession: vi.fn(),
  registerAcpStateListener: vi.fn(() => () => {}),
  reportEntryState: vi.fn(),
}));

vi.mock('./session.js', () => sessionMocks);

const spec: AcpCreateSpec = {
  kind: 'acp',
  workloadType: 'Deployment',
  threadId: 'thread_1',
  namespace: { name: 'canvas_1' },
  spec: {
    binding: { alias: 'copilot', profileId: 'profile_1' },
    recipe: {
      alias: 'copilot',
      command: 'copilot --acp',
      cwd: '/repo',
    },
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
  authorizeHistoryLoad: AgentCreateContext<AcpDurableState>['recovery']['authorizeHistoryLoad'],
): AgentCreateContext<AcpDurableState> {
  return {
    recoveryInput: {
      state: {
        driverState: {
          sessionId: 'stale_session',
          initialPreambleDelivered: false,
        },
        metadata: { currentModeId: 'ask' },
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
      initialPreambleDelivered: false,
      persistedToDisk: false,
    } as unknown as AcpSessionEntry,
    prompt,
  };
}

const submission = {
  type: 'user_text',
  content: 'current request',
  rendered: [{ type: 'text' as const, text: 'current request' }],
};

describe('ACP durable history recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ACP canonical input lowering', () => {
    it('flattens members into one ordered prompt while preserving commands', () => {
      expect(
        lowerAcpInputs([
          {
            type: 'command',
            text: '/review',
            context: [
              { type: 'text', text: 'selection' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ]),
      ).toEqual({
        blocks: [
          { type: 'text', text: '/review' },
          { type: 'text', text: 'selection' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
        serialized: '/review\nselection',
        isCommand: true,
      });
    });
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
    for await (const _event of handle.run(submission, {
      overlay: emptyAcpOverlay(),
      logger,
    })) {
      // Drain the turn.
    }

    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledTimes(2);
    expect(sessionMocks.ensureAcpSession.mock.calls[0]?.[0]).toMatchObject({
      priorState: {
        driverState: {
          sessionId: 'stale_session',
          initialPreambleDelivered: false,
        },
      },
    });
    expect(sessionMocks.ensureAcpSession.mock.calls[1]?.[0]).toMatchObject({
      priorState: {
        driverState: { initialPreambleDelivered: false },
        metadata: { currentModeId: 'ask' },
      },
    });
    expect(
      sessionMocks.ensureAcpSession.mock.calls[1]?.[0]?.priorState?.driverState,
    ).not.toHaveProperty('sessionId');
    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'recover',
      turns: [foldedTurn],
    });
    expect(prompt.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(
          '"rendered":[{"type":"text","text":"earlier question"}]',
        ),
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
        .run(submission, {
          overlay: emptyAcpOverlay(),
          logger,
        })
        .next(),
    ).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledTimes(1);
    expect(authorizeHistoryLoad).not.toHaveBeenCalled();
  });

  it('persists a command-created session without consuming its preamble', async () => {
    const { entry, prompt } = sessionEntry();
    sessionMocks.ensureAcpSession.mockResolvedValue(entry);
    const handle = new AcpAgentHandle(
      {
        ...spec,
        spec: { ...spec.spec, initialPreamble: ['SYSTEM'] },
      },
      {
        recovery: {
          authorizeHistoryLoad: vi.fn(async () => ({
            allowed: true as const,
            estimatedSize: 0,
          })),
        },
      },
    );

    for await (const _event of handle.run(
      {
        type: 'huabu.chat',
        content: {},
        rendered: [{ type: 'command', text: '/compact', context: [] }],
      },
      { overlay: emptyAcpOverlay(), logger },
    )) {
      // Drain the command turn.
    }

    expect(prompt.mock.calls[0]?.[1]).toEqual([
      { type: 'text', text: '/compact' },
    ]);
    expect(entry.persistedToDisk).toBe(true);
    expect(entry.initialPreambleDelivered).toBe(false);

    for await (const _event of handle.run(
      {
        type: 'huabu.chat',
        content: {},
        rendered: [{ type: 'text', text: 'hello' }],
      },
      { overlay: emptyAcpOverlay(), logger },
    )) {
      // Drain the ordinary turn.
    }

    expect(prompt.mock.calls[1]?.[1]).toEqual([
      { type: 'text', text: 'SYSTEM' },
      { type: 'text', text: 'hello' },
    ]);
    expect(entry.initialPreambleDelivered).toBe(true);
    expect(sessionMocks.reportEntryState).toHaveBeenCalledTimes(4);
  });
});
