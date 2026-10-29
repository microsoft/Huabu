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
import { resolveQuestionHeaderFit } from './useQuestionHeaderFit';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) =>
      key.startsWith('node.questionCard.')
        ? zh.node.questionCard[
            key.split('.').at(-1) as keyof typeof zh.node.questionCard
          ]
        : key,
  }),
}));

describe('QuestionConversationCard', () => {
  it('uses the same 24px default as shared card titles', () => {
    expect(QUESTION_NODE_DEFAULT_FONT_SIZE).toBe(24);
    expect(NODE_TYPOGRAPHY.cardTitle.size).toBe(24);
    const scale = 1;
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
    ).toBeCloseTo(16 * scale);
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
        effectiveFontSize={QUESTION_NODE_DEFAULT_FONT_SIZE}
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
    expect(card.style.padding).toBe('16px');
    expect(card.style.getPropertyValue('--question-header-gap')).toBe('8px');
    expect(
      host
        .querySelector('.question-conversation-agent')
        ?.getAttribute('aria-label'),
    ).toBe('Huabu');
    expect(
      host
        .querySelector('.question-conversation-main')
        ?.firstElementChild?.querySelector('.question-conversation-agent'),
    ).not.toBeNull();
    expect(host.querySelectorAll('.question-conversation-agent')).toHaveLength(
      1,
    );
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
      Number(
        host
          .querySelector('.question-conversation-status svg')
          ?.getAttribute('width'),
      ),
    ).toBe(16);
    expect(card.style.getPropertyValue('--question-title-line')).toBe('1.3');
    expect(card.style.getPropertyValue('--question-title-weight')).toBe('500');
    expect(
      (host.querySelector('.question-conversation-question') as HTMLElement)
        .style.fontSize,
    ).toBe('24px');
    expect(getQuestionFontOpts()).toMatchObject({
      fontWeight: '500',
      lineHeight: 1.3,
    });
  });

  it.each([24, 28, 35, 48])(
    'scales header text and status icons from the default font basis at %spx',
    (fontSize) => {
      const scale = fontSize / QUESTION_NODE_DEFAULT_FONT_SIZE;
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        <QuestionConversationCard
          agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
          status="idle"
          isOpen
          unread={false}
          conflictCount={0}
          text="Question"
          placeholder="Ask"
          effectiveWidth={550}
          effectiveHeight={150}
          effectiveFontSize={fontSize}
          paddingX={QUESTION_NODE_PADDING * scale}
          paddingY={
            (QUESTION_NODE_PADDING_Y + QUESTION_NODE_HEADER_INSET) * scale
          }
        />,
      );
      const card = host.firstElementChild as HTMLElement;
      const headerScale = fontSize / QUESTION_NODE_DEFAULT_FONT_SIZE;
      expect(
        parseFloat(card.style.getPropertyValue('--question-edge-width')),
      ).toBe(1);
      expect(
        parseFloat(card.style.getPropertyValue('--question-status-padding-x')),
      ).toBeCloseTo(6 * headerScale);
      expect(
        parseFloat(card.style.getPropertyValue('--question-icon-slot-width')),
      ).toBeCloseTo(28 * scale);
      expect(
        parseFloat(card.style.getPropertyValue('--question-icon-gap')),
      ).toBeCloseTo(8 * scale);
      for (const variable of [
        '--question-meta-size',
        '--question-status-size',
      ]) {
        expect(parseFloat(card.style.getPropertyValue(variable))).toBeCloseTo(
          18 * headerScale,
        );
      }
      const icon = host.querySelector('.question-conversation-status svg');
      for (const dimension of ['width', 'height']) {
        expect(Number(icon?.getAttribute(dimension))).toBeCloseTo(
          16 * headerScale,
        );
      }
      expect(
        parseFloat(card.style.getPropertyValue('--question-header-height')),
      ).toBeCloseTo(32 * scale);
      expect(parseFloat(card.style.paddingLeft)).toBeCloseTo(16 * scale);
      expect(parseFloat(card.style.paddingTop)).toBeCloseTo(16 * scale);
      expect(
        Number(
          host
            .querySelector('.question-conversation-agent svg')
            ?.getAttribute('width'),
        ),
      ).toBeCloseTo(28 * scale);
      expect(
        (host.querySelector('.question-conversation-question') as HTMLElement)
          .style.fontSize,
      ).toBe(`${fontSize}px`);
    },
  );

  it.each([
    [148, true, true, true],
    [147.99, false, true, true],
    [132, false, true, true],
    [131.99, true, true, false],
    [84, true, true, false],
    [83.99, false, true, false],
    [68, false, true, false],
    [67.99, true, false, false],
  ])(
    'reserves pill padding at header width %s',
    (width, alias, status, statusText) => {
      expect(
        resolveQuestionHeaderFit({
          width,
          avatar: 32,
          gap: 8,
          alias: 8,
          label: 60,
          icon: 16,
          statusPaddingX: 6,
        }),
      ).toEqual({ alias, status, statusText });
    },
  );

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
        status === 'done' ? 'unread' : status === 'idle' ? 'open' : status,
      );
      expect(
        open.querySelector('.question-conversation-status')?.textContent,
      ).toBe(
        status === 'idle'
          ? zh.node.questionCard.open
          : closed.querySelector('.question-conversation-status')?.textContent,
      );
      expect(
        open
          .querySelector('.question-conversation-status')
          ?.getAttribute('title'),
      ).toBe(
        status === 'idle'
          ? zh.node.questionCard.open
          : closed
              .querySelector('.question-conversation-status')
              ?.getAttribute('title'),
      );
      expect(closed.firstElementChild?.getAttribute('data-state')).toBe(
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

  it.each([
    ['idle', false, 0, 'open'],
    ['running', false, 0, 'running'],
    ['approval', true, 2, 'approval'],
    ['done', true, 0, 'unread'],
    ['done', false, 0, 'viewed'],
    ['done', true, 2, 'conflict'],
    ['done', false, 2, 'conflict'],
    ['error', true, 0, 'error'],
    ['error', false, 0, 'error'],
  ] as const)(
    'maps actively open %s without hiding lifecycle or attention',
    (status, unread, conflicts, expected) => {
      expect(resolveQuestionCardState(status, unread, conflicts, true)).toBe(
        expected,
      );
    },
  );
});
