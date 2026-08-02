import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpServiceError } from './errors.js';
import { AcpAgentHandle, lowerAcpInputs } from './handle.js';
import { emptyAcpOverlay } from './overlay.js';
import { acpSessionRegistry } from './session-registry.js';

import type { AcpCreateSpec, AcpDurableState } from './handle.js';
import type { AcpSessionEntry } from './session-registry.js';
import type { AgentTurn, SessionId } from '@agenetes/protocol';
import type { AgentCreateContext } from '@agenetes/runtime';

const sessionMocks = vi.hoisted(() => ({
  ensureAcpSession: vi.fn(),
  registerAcpStateListener: vi.fn(() => () => {}),
  reportEntryState: vi.fn(),
  awaitSelectionReplay: vi.fn(async () => {}),
  recordSessionSelection: vi.fn(),
  MODE_SELECTION_ID: 'mode',
  MODEL_SELECTION_ID: 'model',
}));

vi.mock('./session.js', () => sessionMocks);

const spec: AcpCreateSpec = {
  kind: 'acp',
  workloadType: 'Deployment',
  threadId: 'thread_1',
  namespace: { name: 'canvas_1' },
  spec: {
    agentletId: 'machine-a',
    binding: { alias: 'copilot', profileId: 'profile_1' },
    recipe: {
      alias: 'copilot',
      command: 'copilot --acp',
      cwd: '/repo',
      autoRestart: true,
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
  turns: readonly AgentTurn[] = [foldedTurn],
): AgentCreateContext<AcpDurableState> {
  return {
    recoveryInput: {
      state: {
        driverState: {
          sessionId: 'stale_session' as SessionId,
          initialPreambleDelivered: false,
        },
        metadata: { currentModeId: 'ask' },
      },
      turns,
    },
    recovery: { authorizeHistoryLoad },
  };
}

function sessionEntry() {
  const prompt = vi.fn(async (..._args: unknown[]) => ({
    stopReason: 'end_turn',
  }));
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
    acpSessionRegistry.remove('machine-a', spec.threadId);
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
      repairFromClosedEntry: false,
    });
    expect(
      sessionMocks.ensureAcpSession.mock.calls[1]?.[0]?.priorState?.driverState,
    ).not.toHaveProperty('sessionId');
    expect(authorizeHistoryLoad).toHaveBeenCalledWith({
      mode: 'recover',
      turns: [
        {
          ...foldedTurn,
          request: {
            ...foldedTurn.request,
            rendered: [{ type: 'text', text: 'earlier question' }],
          },
        },
      ],
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

  it('omits historical image bodies from the text replay', async () => {
    const imageData = 'aGVsbG8='.repeat(2_000);
    const imageTurn: AgentTurn = {
      ...foldedTurn,
      request: {
        type: 'user_text',
        content: 'earlier question',
        rendered: [
          {
            type: 'parts',
            parts: [
              { type: 'text', text: 'inspect this image' },
              { type: 'image', data: imageData, mimeType: 'image/png' },
            ],
          },
        ],
      },
    };
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
      durableContext(authorizeHistoryLoad, [imageTurn]),
    );
    for await (const _event of handle.run(submission, {
      overlay: emptyAcpOverlay(),
      logger,
    })) {
      // Drain the turn.
    }

    const authorized = JSON.stringify(
      authorizeHistoryLoad.mock.calls[0]?.[0]?.turns,
    );
    expect(authorized).not.toContain(imageData);
    expect(authorized).toContain('image omitted from text-only history replay');

    const historyBlock = prompt.mock.calls[0]?.[1]?.[0] as { text: string };
    expect(historyBlock.text).not.toContain(imageData);
    expect(historyBlock.text).toContain('inspect this image');
    expect(historyBlock.text).toContain(
      'image omitted from text-only history replay',
    );
  });

  it('keeps native recovery and history fallback in one Handle singleflight', async () => {
    let authorizeFallback: (() => void) | undefined;
    const authorizeHistoryLoad = vi.fn(
      () =>
        new Promise<{ allowed: true; estimatedSize: number }>((resolve) => {
          authorizeFallback = () =>
            resolve({ allowed: true, estimatedSize: 100 });
        }),
    );
    const { entry } = sessionEntry();
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

    const first = handle
      .run(submission, { overlay: emptyAcpOverlay(), logger })
      .next();
    await vi.waitFor(() => {
      expect(authorizeHistoryLoad).toHaveBeenCalledOnce();
    });
    const second = handle
      .run(submission, { overlay: emptyAcpOverlay(), logger })
      .next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledOnce();
    authorizeFallback?.();
    await Promise.all([first, second]);
    expect(sessionMocks.ensureAcpSession).toHaveBeenCalledTimes(2);
    expect(authorizeHistoryLoad).toHaveBeenCalledOnce();
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

  it('rejects control operations while the underlying session is suspended', async () => {
    const setSessionMode = vi.fn();
    acpSessionRegistry.set('machine-a', spec.threadId, {
      ...sessionEntry().entry,
      agentletId: 'machine-a',
      threadId: spec.threadId,
      client: {
        isClosed: true,
        shutdown: vi.fn(),
        setSessionMode,
      },
    } as unknown as AcpSessionEntry);
    const handle = new AcpAgentHandle(spec, {
      recovery: {
        authorizeHistoryLoad: vi.fn(),
      },
    });

    await expect(
      handle.control({ type: 'set_mode', data: { modeId: 'plan' } }),
    ).resolves.toEqual({
      ok: false,
      error: `ACP session is suspended for thread ${spec.threadId}; send a message to reconnect`,
      code: 'session_suspended',
    });
    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it('does not dispatch a prompt when aborted during session bootstrap', async () => {
    const { entry, prompt } = sessionEntry();
    let finishBootstrap: ((entry: AcpSessionEntry) => void) | undefined;
    sessionMocks.ensureAcpSession.mockImplementationOnce(
      () =>
        new Promise<AcpSessionEntry>((resolve) => {
          finishBootstrap = resolve;
        }),
    );
    const controller = new AbortController();
    const handle = new AcpAgentHandle(spec, {
      recovery: {
        authorizeHistoryLoad: vi.fn(async () => ({
          allowed: true as const,
          estimatedSize: 0,
        })),
      },
    });

    const next = handle
      .run(submission, {
        overlay: emptyAcpOverlay(),
        signal: controller.signal,
        logger,
      })
      .next();
    await vi.waitFor(() => {
      expect(sessionMocks.ensureAcpSession).toHaveBeenCalledOnce();
    });
    controller.abort();
    finishBootstrap?.(entry);

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(prompt).not.toHaveBeenCalled();
    expect(sessionMocks.reportEntryState).not.toHaveBeenCalled();
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
