import { describe, expect, it } from 'vitest';

import { resolveQuestionBadgeChrome } from './questionBadgeChrome';
import { resolveQuestionBadgeBackground } from './QuestionTakeoverMark';

import type { QuestionAgentBadgeStatus } from './QuestionAgentBadge';

describe('QuestionTakeoverMark', () => {
  it.each<QuestionAgentBadgeStatus>(['running', 'done', 'error'])(
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
});
