// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { UserMessage } from './UserMessage';

import type { InkInterpretation } from '@huabu/shared';

vi.mock('@/components/Nodes/NodeRef/NodeRef', () => ({
  NodeRef: ({
    nodeId,
    strokeCount,
  }: {
    nodeId?: string;
    strokeCount?: number;
  }) => (
    <span data-source={nodeId}>
      {nodeId} {strokeCount}
    </span>
  ),
}));

let container: HTMLDivElement | undefined;

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe('UserMessage', () => {
  it.each([true, false])(
    'removes only the leading message top margins when isFirst=%s',
    (isFirst) => {
      container = document.createElement('div');
      const root = createRoot(container);
      act(() => root.render(<UserMessage content="Hello" isFirst={isFirst} />));
      const message = container.querySelector('[data-chat-user-message]');
      expect(message?.classList.contains('mt-0')).toBe(isFirst);
      expect(message?.firstElementChild?.classList.contains('mt-2')).toBe(
        !isFirst,
      );
      expect(message?.classList.contains('my-3')).toBe(true);
      act(() => root.unmount());
    },
  );

  it.each(['', 'Overall instructions'])(
    'renders quoted comments as cards alongside user text %j',
    (content) => {
      container = document.createElement('div');
      const root = createRoot(container);
      act(() =>
        root.render(
          <UserMessage
            content={content}
            quotedComments={[
              {
                quote: 'First passage',
                contextBefore: 'Before ',
                contextAfter: ' after',
                comment: 'Explain this.',
              },
              {
                quote: 'Second passage',
                contextBefore: '',
                contextAfter: '',
                comment: 'Compare it.',
              },
            ]}
          />,
        ),
      );
      expect(container.querySelectorAll('[data-quoted-comment]')).toHaveLength(
        2,
      );
      expect(
        [...container.querySelectorAll('blockquote')].map(
          (item) => item.textContent,
        ),
      ).toEqual(['First passage', 'Second passage']);
      for (const quote of container.querySelectorAll('blockquote')) {
        expect(quote.classList.contains('border-l-2')).toBe(true);
        expect(quote.classList.contains('border-edge-default')).toBe(true);
      }
      expect(container.querySelector('svg.lucide-quote')).toBeNull();
      expect(container.textContent).toContain('Explain this.');
      expect(container.textContent).toContain('Compare it.');
      expect(
        container.querySelector('[data-chat-prompt-content]')?.textContent ??
          '',
      ).toBe(content);
      if (content) expect(container.textContent).toContain(content);
      expect(container.textContent).not.toContain(
        'Quote from an earlier reply:',
      );
      expect(container.textContent).not.toContain('<quoted_comments>');
      expect(container.querySelector('input')).toBeNull();
      expect(container.querySelector('details')).toBeNull();
      expect(container.textContent).not.toContain('Before');
      expect(container.textContent).not.toContain(' after');
      act(() => root.unmount());
    },
  );

  it('renders an honest label for an empty Ink request', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<UserMessage content="" inputKind="ink-intent" />);
    });

    expect(
      container.querySelector('svg[aria-label="Ink request"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Agent interpretation');
    expect(container.textContent).toContain('older Ink request');
    expect(container.querySelector('[data-chat-user-message]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('identifies node-only requests without claiming they contain handwriting', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <UserMessage
          content=""
          inputKind="selection-intent"
          inkInterpretation={{
            state: 'reported',
            text: 'Summarize the selected material',
          }}
        />,
      );
    });
    expect(
      container.querySelector('svg[aria-label="Selection request"]'),
    ).not.toBeNull();
    expect(container.textContent).toBe('Summarize the selected material');
    expect(
      container
        .querySelector('[data-ink-interpretation]')
        ?.getAttribute('aria-description'),
    ).toBe('Agent interpretation of the selection');
    act(() => root.unmount());
  });

  it('renders only the inline summary beside the pen, preserving sources and content', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <UserMessage
          content="My original words"
          inputKind="ink-intent"
          inkInterpretation={{
            state: 'reported',
            text: 'Expand the third comparison step',
            explanation: 'The arrow connects to the third comparison.',
          }}
          selectedNodeIds={['sketch-1']}
          selectedStrokeIds={[{ nodeId: 'sketch-1', strokeIds: ['s1', 's2'] }]}
          invokedSkills={['research']}
        />,
      );
    });

    expect(container.textContent).toContain('Expand the third comparison step');
    expect(container.textContent).not.toContain('Ink request');
    expect(container.textContent).not.toContain('Agent interpretation');
    expect(container.textContent).not.toContain(
      'The arrow connects to the third comparison.',
    );
    const interpretation = container.querySelector('[data-ink-interpretation]');
    expect(interpretation?.tagName).toBe('SPAN');
    expect(interpretation?.textContent).toBe(
      'Expand the third comparison step',
    );
    expect(interpretation?.getAttribute('aria-description')).toBe(
      'Agent interpretation',
    );
    expect(interpretation?.parentElement?.querySelector('svg')).not.toBeNull();
    expect(interpretation?.previousElementSibling?.tagName.toLowerCase()).toBe(
      'svg',
    );
    expect(interpretation?.nextElementSibling?.textContent).toBe('/research');
    expect(interpretation?.parentElement?.textContent).toBe(
      'Expand the third comparison step /research My original words',
    );
    expect(
      container.querySelector('.text-fg-muted, .text-fg-subtle'),
    ).toBeNull();
    expect(container.textContent).toContain('My original words');
    expect(
      container.querySelector('[data-chat-prompt-content]')?.textContent,
    ).toBe('My original words');
    expect(
      container.querySelector('[data-source="sketch-1"]')?.textContent,
    ).toBe('sketch-1 2');
    expect(
      container.querySelector('[data-ink-interpretation] [title]'),
    ).toBeNull();
    expect(container.textContent).not.toMatch(
      /\b(inferred|clarify|unsupported)\b/i,
    );
    act(() => root.unmount());
  });

  it.each([
    ['pending', 'Waiting for the Agent’s interpretation…'],
    ['missing', 'The Agent finished without reporting an interpretation.'],
    ['failed', 'The interpretation could not be reported.'],
    [
      'interrupted',
      'The request was interrupted before an interpretation was reported.',
    ],
    ['legacy', 'No interpretation is available for this older Ink request.'],
  ] as const)('renders visible %s delivery feedback', (state, feedback) => {
    container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <UserMessage
          content=""
          inputKind="ink-intent"
          inkInterpretation={{ state } as InkInterpretation}
        />,
      ),
    );
    expect(container.textContent).toBe(feedback);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      feedback,
    );
    act(() => root.unmount());
  });

  it('does not add Ink feedback to ordinary text', () => {
    container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(<UserMessage content="Hello" invokedSkills={['research']} />),
    );
    expect(container.textContent).toBe('/researchHello');
    expect(container.querySelector('[data-ink-interpretation]')).toBeNull();
    act(() => root.unmount());
  });

  it('localizes icon accessibility and inline delivery feedback in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <UserMessage
          content=""
          inputKind="ink-intent"
          inkInterpretation={{ state: 'pending' }}
        />,
      ),
    );
    expect(container.textContent).not.toContain('Agent 的理解');
    expect(
      container.querySelector('svg[aria-label="笔迹请求"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '正在等待 Agent 报告理解…',
    );
    act(() => root.unmount());
  });
});
