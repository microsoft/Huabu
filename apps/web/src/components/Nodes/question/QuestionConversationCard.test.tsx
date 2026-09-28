// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import zh from '@/i18n/resources/zh-CN/common.json';
import {
  getQuestionFontOpts,
  QUESTION_NODE_DEFAULT_FONT_SIZE,
  QUESTION_NODE_HEADER_INSET,
  QUESTION_NODE_PADDING,
  QUESTION_NODE_PADDING_Y,
} from '@/utils/node/nodeFontConfig';

import {
  QuestionConversationCard,
  resolveQuestionCardState,
} from './QuestionConversationCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.startsWith('node.questionCard.')
        ? zh.node.questionCard[
            key.split('.').at(-1) as keyof typeof zh.node.questionCard
          ]
        : key,
  }),
}));

describe('QuestionConversationCard', () => {
  it('uses a Question-only 24px default without changing shared card titles', () => {
    expect(QUESTION_NODE_DEFAULT_FONT_SIZE).toBe(24);
    expect(NODE_TYPOGRAPHY.cardTitle.size).toBe(28);
    const scale =
      QUESTION_NODE_DEFAULT_FONT_SIZE / NODE_TYPOGRAPHY.cardTitle.size;
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <QuestionConversationCard
        agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
        status="idle"
        unread={false}
        conflictCount={0}
        text="Question label"
        placeholder="Ask"
        effectiveWidth={280}
        effectiveHeight={100}
        effectiveFontSize={QUESTION_NODE_DEFAULT_FONT_SIZE}
        paddingX={QUESTION_NODE_PADDING * scale}
        paddingY={
          (QUESTION_NODE_PADDING_Y + QUESTION_NODE_HEADER_INSET) * scale
        }
      />,
    );
    expect(
      (host.querySelector('.question-conversation-question') as HTMLElement)
        .style.fontSize,
    ).toBe('24px');
    expect(
      parseFloat((host.firstElementChild as HTMLElement).style.paddingTop),
    ).toBeCloseTo(24 * scale);
  });
  it.each([
    ['idle', false, 0, 'idle'],
    ['running', false, 0, 'running'],
    ['approval', true, 2, 'approval'],
    ['open', true, 2, 'open'],
    ['done', true, 0, 'unread'],
    ['done', false, 0, 'viewed'],
    ['done', true, 2, 'conflict'],
    ['done', false, 2, 'conflict'],
    ['error', true, 0, 'error'],
    ['error', false, 0, 'error'],
  ] as const)(
    'maps %s with viewed/conflict information',
    (status, unread, conflicts, expected) => {
      expect(resolveQuestionCardState(status, unread, conflicts)).toBe(
        expected,
      );
    },
  );

  it('renders short unread copy, full hover meaning, identity and real question with measured insets', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <QuestionConversationCard
        agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
        status="done"
        unread
        conflictCount={0}
        text="Actual question"
        placeholder="Ask"
        effectiveWidth={280}
        effectiveHeight={100}
        effectiveFontSize={NODE_TYPOGRAPHY.cardTitle.size}
        paddingX={QUESTION_NODE_PADDING}
        paddingY={QUESTION_NODE_PADDING_Y + QUESTION_NODE_HEADER_INSET}
      />,
    );
    expect(
      host.querySelector('.question-conversation-status')?.textContent,
    ).toBe('待查看');
    expect(
      host
        .querySelector('.question-conversation-status')
        ?.getAttribute('title'),
    ).toBe('本轮结束 · 未查看');
    expect(
      host.querySelector('.question-conversation-question')?.textContent,
    ).toBe('Actual question');
    const card = host.firstElementChild as HTMLElement;
    expect(card.style.width).toBe('280px');
    expect(card.style.height).toBe('100px');
    expect(card.style.padding).toBe('24px');
    expect(card.style.getPropertyValue('--question-header-gap')).toBe('12px');
    expect(
      host.querySelector('.question-conversation-agent')?.textContent,
    ).toBe('Huabu');
    expect(host.querySelector('button')).toBeNull();
    expect(
      host.querySelector('.question-conversation-status svg'),
    ).not.toBeNull();
    expect(host.querySelector('.question-conversation-rail')).toBeNull();
    expect(card.style.getPropertyValue('--question-status-size')).toBe('18px');
    expect(card.style.getPropertyValue('--question-header-height')).toBe(
      '32px',
    );
    expect(card.style.getPropertyValue('--question-meta-size')).toBe('18px');
    expect(card.style.getPropertyValue('--question-meta-line')).toBe('1.4');
    expect(
      host
        .querySelector('.question-conversation-status svg')
        ?.getAttribute('width'),
    ).toBe('16');
    expect(card.style.getPropertyValue('--question-title-line')).toBe('1.3');
    expect(card.style.getPropertyValue('--question-title-weight')).toBe('500');
    expect(
      (host.querySelector('.question-conversation-question') as HTMLElement)
        .style.fontSize,
    ).toBe('28px');
    expect(getQuestionFontOpts()).toMatchObject({
      fontWeight: '500',
      lineHeight: 1.3,
    });
  });

  it.each(['idle', 'running', 'approval', 'done', 'error'] as const)(
    'keeps %s lifecycle and content geometry when open, at fractional scale',
    (status) => {
      const render = (isOpen: boolean) => {
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
          <QuestionConversationCard
            agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
            status={status}
            isOpen={isOpen}
            unread
            conflictCount={0}
            text="Question"
            placeholder="Ask"
            effectiveWidth={550}
            effectiveHeight={150}
            effectiveFontSize={35}
            paddingX={QUESTION_NODE_PADDING * 1.25}
            paddingY={
              (QUESTION_NODE_PADDING_Y + QUESTION_NODE_HEADER_INSET) * 1.25
            }
          />,
        );
        return host;
      };
      const closed = render(false);
      const open = render(true);
      expect(open.firstElementChild?.getAttribute('style')).toBe(
        closed.firstElementChild?.getAttribute('style'),
      );
      expect(open.firstElementChild?.getAttribute('data-state')).toBe(
        status === 'done' ? 'unread' : status,
      );
      expect(open.querySelector('.question-conversation-tail')).toBeNull();
      expect(closed.querySelector('.question-conversation-tail')).toBeNull();
      expect(
        open.querySelectorAll('.question-conversation-status svg'),
      ).toHaveLength(1);
      expect(
        open.querySelector('.question-conversation-question')?.outerHTML,
      ).toBe(
        closed.querySelector('.question-conversation-question')?.outerHTML,
      );
    },
  );
});
