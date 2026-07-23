import { describe, expect, it } from 'vitest';

import { resolveQuestionBadgeChrome } from './questionBadgeChrome';
import {
  resolveQuestionBadgeBackground,
  resolveQuestionSpecialRingGeometry,
} from './QuestionTakeoverMark';

import type { QuestionAgentBadgeStatus } from './QuestionAgentBadge';

describe('QuestionTakeoverMark', () => {
  it.each<QuestionAgentBadgeStatus>(['running', 'approval', 'done', 'error'])(
    'keeps the sticker background for %s',
    (status) => {
      const chrome = resolveQuestionBadgeChrome({
        status,
        agent: { kind: 'internal', alias: 'Huabu', mode: 'ask' },
        unread: false,
        conflictCount: 0,
      });

      expect(
        resolveQuestionBadgeBackground({
          isIdle: false,
          isOpen: chrome.isOpen,
          stickerFill: chrome.stickerFill,
        }),
      ).toBe(chrome.stickerFill);
    },
  );

  it('uses a static warning hold ring for approval', () => {
    const chrome = resolveQuestionBadgeChrome({
      status: 'approval',
      agent: { kind: 'internal', alias: 'Huabu', mode: 'ask' },
      unread: false,
      conflictCount: 0,
    });

    expect(chrome).toMatchObject({
      isApproval: true,
      isRunning: false,
      needsAttention: true,
      attentionColor: 'var(--warning)',
      ringBorderColor: 'transparent',
    });
  });

  it('scales special status rings with the mark size', () => {
    expect(resolveQuestionSpecialRingGeometry(6)).toEqual({
      inset: 0.5,
      width: 0.75,
    });
    expect(resolveQuestionSpecialRingGeometry(36)).toEqual({
      inset: 2,
      width: 3,
    });
    expect(resolveQuestionSpecialRingGeometry(84)).toEqual({
      inset: 3.5,
      width: 5,
    });
  });
});
