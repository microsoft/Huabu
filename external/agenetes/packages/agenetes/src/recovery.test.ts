import { describe, expect, it, vi } from 'vitest';

import {
  createAgentRecoveryContext,
  estimateHistoryLoadSize,
} from './recovery.js';

import type { AgentTurn } from '@agenetes/protocol';

const turn = (content: string): AgentTurn => ({
  request: { type: 'user_text', content },
  transcript: [{ type: 'text', data: { content: `reply:${content}` } }],
});

describe('history-load recovery policy', () => {
  it('estimates serialized folded turns with the documented byte heuristic', () => {
    const turns = [turn('hello'), turn('world')];
    const bytes = turns.reduce(
      (total, item) => total + Buffer.byteLength(JSON.stringify(item), 'utf8'),
      0,
    );
    expect(estimateHistoryLoadSize(turns)).toBe(Math.ceil(bytes / 4.5));
  });

  it('allows recovery within the safe limit', async () => {
    const context = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 10_000,
      onThresholdExceeded: 'deny',
    });
    await expect(
      context.authorizeHistoryLoad({
        mode: 'recover',
        turns: [turn('small')],
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('disables only automatic recovery, not explicit fork', async () => {
    const turns = [turn('small')];
    const context = createAgentRecoveryContext({
      enabled: false,
      safeHistoryLoadLimit: 10_000,
      onThresholdExceeded: 'deny',
    });
    await expect(
      context.authorizeHistoryLoad({ mode: 'recover', turns }),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'auto_recover_disabled',
    });
    await expect(
      context.authorizeHistoryLoad({ mode: 'fork', turns }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('returns structured threshold and confirmation denials', async () => {
    const turns = [turn('oversized')];
    const deny = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 0,
      onThresholdExceeded: 'deny',
    });
    await expect(
      deny.authorizeHistoryLoad({ mode: 'recover', turns }),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'safe_limit_exceeded',
      safeLimit: 0,
    });

    const unavailable = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 0,
      onThresholdExceeded: 'confirm',
    });
    await expect(
      unavailable.authorizeHistoryLoad({ mode: 'recover', turns }),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'confirmation_unavailable',
    });

    const declined = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 0,
      onThresholdExceeded: 'confirm',
      confirm: async () => false,
    });
    await expect(
      declined.authorizeHistoryLoad({ mode: 'recover', turns }),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'confirmation_declined',
    });
  });

  it('passes confirmation context through and propagates handler failures', async () => {
    const turns = [turn('oversized')];
    const confirm = vi.fn(async () => true);
    const allowed = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 0,
      onThresholdExceeded: 'confirm',
      confirm,
    });
    await expect(
      allowed.authorizeHistoryLoad({ mode: 'fork', turns }),
    ).resolves.toMatchObject({ allowed: true });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fork',
        turns,
        safeLimit: 0,
      }),
    );

    const failed = createAgentRecoveryContext({
      enabled: true,
      safeHistoryLoadLimit: 0,
      onThresholdExceeded: 'confirm',
      confirm: async () => {
        throw new Error('confirmation transport failed');
      },
    });
    await expect(
      failed.authorizeHistoryLoad({ mode: 'recover', turns }),
    ).rejects.toThrow('confirmation transport failed');
  });
});
