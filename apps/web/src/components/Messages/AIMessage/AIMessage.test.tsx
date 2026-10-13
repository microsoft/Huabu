// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantDisclosure } from '../AssistantDisclosure';

import { AIMessage } from './index';

import type { AssistantSegment } from '../../../store/chatTypes';
import type { GenericToolPart } from '@huabu/shared';
import type * as ReactI18next from 'react-i18next';

const { addNode, copy } = vi.hoisted(() => ({
  addNode: vi.fn(),
  copy: vi.fn(),
}));

vi.mock('../../../store/canvasStore', () => ({
  default: (selector: (state: { addNode: typeof addNode }) => unknown) =>
    selector({ addNode }),
}));
vi.mock('../../../hooks/useChatSession', () => ({
  useChatSession: () => ({ threadId: 'thread-1' }),
}));
vi.mock('../../../utils/io/clipboard', () => ({
  copyToClipboard: copy,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
vi.mock('lottie-react', () => ({ default: () => null }));
vi.mock('./MilkdownMessageCard', () => ({
  MilkdownMessageCard: ({
    content,
    segmentIndex,
    enableComments,
  }: {
    content: string;
    segmentIndex: number;
    enableComments: boolean;
  }) => (
    <div data-prose-index={segmentIndex} data-comments={enableComments}>
      {content}
    </div>
  ),
}));
vi.mock('../../Common/ThinkingIndicator', () => ({
  ThinkingIndicator: () => <div data-thinking-indicator />,
}));

function tool(id: string, title = `Read ${id}`): GenericToolPart {
  return {
    kind: 'tool',
    variant: 'generic',
    toolCallId: id,
    title,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: `Output ${id}` },
      },
    ],
  };
}

const initial: AssistantSegment[] = [
  tool('a'),
  { kind: 'thinking', text: 'Checking the findings\n\nReasoning detail' },
  tool('b'),
];

let root: Root;
let container: HTMLDivElement;

function render(
  segments = initial,
  props: Partial<ComponentProps<typeof AIMessage>> = {},
) {
  act(() =>
    root.render(
      <AIMessage
        messageId="assistant-1"
        segments={segments}
        isStreaming
        {...props}
      />,
    ),
  );
}

function header(index = 0): HTMLButtonElement {
  const button = container
    .querySelectorAll('[data-assistant-activity]')
    [index]?.querySelector('button');
  if (!button) throw new Error(`Missing activity header ${index}`);
  return button;
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (element) =>
      element.textContent === label ||
      element.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('assistant activity presentation', () => {
  it.each([
    ['**Explaining origin framework**', 'Explaining origin framework'],
    ['## **Checking references**', 'Checking references'],
    ['> - Reviewing ~~old~~ *results*', 'Reviewing old results'],
    ['Read [docs](https://example.com) and `file.ts`', 'Read docs and file.ts'],
    [
      'Read `use_agent_stream.ts` as `Array<T>`',
      'Read use_agent_stream.ts as Array<T>',
    ],
    ['`**literal**`', '**literal**'],
  ])(
    'renders full plain thinking for %s without Markdown markup or a length cap',
    (markdown, title) => {
      const text = `${markdown}\n\n${'Full reasoning detail\n\n'.repeat(30)}Last paragraph`;
      render([{ kind: 'thinking', text }, tool('a')]);
      const thinking = container.querySelector('[data-assistant-thinking]');
      expect(thinking?.querySelector('button')).toBeNull();
      expect(thinking?.querySelector('[aria-hidden]')).not.toBeNull();
      expect(
        thinking?.querySelector(
          '.milkdown, [contenteditable], strong, a, code',
        ),
      ).toBeNull();
      expect(
        [...container.querySelectorAll('[data-assistant-thinking] p')].map(
          (p) => p.textContent,
        ),
      ).toEqual([
        title,
        ...Array.from({ length: 30 }, () => 'Full reasoning detail'),
        'Last paragraph',
      ]);
      expect(thinking?.textContent).toContain('Last paragraph');
    },
  );

  it('preserves single line breaks inside plain thinking paragraphs', () => {
    render([
      { kind: 'thinking', text: 'First line\nSecond line\n\nNext paragraph' },
      tool('a'),
    ]);
    const paragraphs = container.querySelectorAll(
      '[data-assistant-thinking] p',
    );
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe('First line\nSecond line');
    expect(paragraphs[0].classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(paragraphs[1].textContent).toBe('Next paragraph');
  });

  it.each([
    '**Checking references**',
    '## Checking references',
    '`Checking references`',
  ])(
    'does not create duplicate details for a short formatted line: %s',
    (text) => {
      render([{ kind: 'thinking', text }], { isStreaming: false });
      const thinking = container.querySelector('[data-assistant-thinking]');
      expect(thinking?.textContent).toBe('Checking references');
      expect(thinking?.querySelector('button')).toBeNull();
      expect(thinking?.querySelector('p')).toBeNull();
    },
  );

  it.each([true, false])(
    'keeps standalone thinking behind its summary when streaming=%s',
    (isStreaming) => {
      render(
        [{ kind: 'thinking', text: '**Checking references**\n\nAll details' }],
        { isStreaming },
      );
      const thinking = container.querySelector('[data-assistant-thinking]');
      const toggle = button('Checking references');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(thinking?.querySelector('span[aria-hidden]')).toBeNull();
      expect(toggle.querySelectorAll('svg')).toHaveLength(1);
      expect(thinking?.textContent).not.toContain('All details');
      act(() => toggle.click());
      expect(thinking?.textContent).toContain('All details');
      expect(thinking?.querySelector('strong')).toBeNull();
    },
  );

  it('shows the full thinking without a second disclosure when a singleton joins an activity', () => {
    const thinking: AssistantSegment = {
      kind: 'thinking',
      text: 'Checking references\n\nAll details',
    };
    render([thinking]);
    expect(button('Checking references').getAttribute('aria-expanded')).toBe(
      'false',
    );
    render([thinking, tool('a')]);
    const row = container.querySelector('[data-assistant-thinking]');
    expect(row?.querySelector('button')).toBeNull();
    expect(row?.textContent).toContain('All details');
    expect(row?.querySelector('[aria-hidden]')).not.toBeNull();
  });

  it('keeps the live spinner but removes the idle leading icon and its spacer', () => {
    render();
    expect(header().querySelectorAll('svg')).toHaveLength(2);
    render(initial, { isStreaming: false });
    expect(header().querySelectorAll('svg')).toHaveLength(1);
    expect(header().firstElementChild?.textContent).toBe(
      'messages.activityCompletedSteps:3',
    );
    act(() => header().click());
    expect(button('Read a').querySelectorAll('svg')).toHaveLength(2);
    expect(
      container.querySelector(
        '[data-assistant-thinking] span[aria-hidden="true"]',
      ),
    ).not.toBeNull();
  });

  it('retains a failed tool marker without adding ordinary tool icons', () => {
    render([{ ...tool('a'), status: 'failed' }], { isStreaming: false });
    expect(button('Read a').querySelectorAll('svg')).toHaveLength(2);
    expect(button('Read a').querySelector('.text-danger')).not.toBeNull();
  });

  it('shows full thinking in a live block while individual tool outputs stay collapsed', () => {
    render();
    expect(
      container.querySelectorAll('[data-assistant-activity]'),
    ).toHaveLength(1);
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(header().textContent).toBe(
      'messages.activityRunning · messages.activitySteps:3',
    );
    expect(container.textContent).toContain('Read a');
    expect(container.textContent).toContain('Checking the findings');
    expect(container.textContent).not.toContain('Output a');
    expect(container.textContent).toContain('Reasoning detail');
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull();
    expect(button('Read a').getAttribute('aria-expanded')).toBe('false');

    const originalHeader = header();
    render([...initial, { kind: 'thinking', text: 'Next check' }, tool('c')]);
    expect(header()).toBe(originalHeader);
    expect(container.textContent).toContain('Next check');
    expect(container.textContent).toContain('Read c');
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  describe('nested tool runs', () => {
    const thinking: AssistantSegment = {
      kind: 'thinking',
      text: 'Full explanation',
    };
    const run = [thinking, tool('a'), tool('b')];
    const runHeader = () => button('messages.activityToolCalls:2');

    it('closes an untouched run when the next thinking arrives, keeping explanations in order', () => {
      render(run);
      expect(runHeader().getAttribute('aria-expanded')).toBe('true');
      expect(button('Read a')).toBeDefined();
      render([
        ...run,
        { kind: 'thinking', text: 'Next explanation' },
        tool('c'),
        tool('d'),
      ]);
      const toggles = [
        ...container.querySelectorAll('[data-assistant-tools]'),
      ].map((run) => run.querySelector('button'));
      expect(toggles).toHaveLength(2);
      expect(toggles[0]?.getAttribute('aria-expanded')).toBe('false');
      expect(toggles[1]?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).not.toContain('Read a');
      expect(container.textContent).toContain('Read c');
      expect(container.textContent?.indexOf('Full explanation')).toBeLessThan(
        container.textContent?.indexOf('Next explanation') ?? 0,
      );
    });

    it('opens a completed outer activity with full thinking and compact tool runs', () => {
      render(run, { isStreaming: false });
      act(() => header().click());
      expect(container.textContent).toContain('Full explanation');
      expect(runHeader().getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Read a');
    });

    it.each([true, false])(
      'preserves an explicit run collapsed=%s through updates and completion',
      (collapsed) => {
        render(run);
        act(() => runHeader().focus());
        act(() => runHeader().click());
        if (!collapsed) act(() => runHeader().click());
        render([...run, { kind: 'thinking', text: 'Next explanation' }], {
          isStreaming: false,
        });
        expect(header().getAttribute('aria-expanded')).toBe('true');
        expect(runHeader().getAttribute('aria-expanded')).toBe(
          String(!collapsed),
        );
      },
    );

    it('preserves inspected tool output and focus when a singleton becomes a run', () => {
      render([thinking, tool('a')]);
      const call = button('Read a');
      act(() => call.click());
      act(() => call.focus());
      render(run);
      expect(button('Read a')).toBe(call);
      expect(document.activeElement).toBe(call);
      expect(container.textContent).toContain('Output a');
      render(run, { isStreaming: false });
      expect(runHeader().getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Output a');
    });

    it('does not add another disclosure for tools-only activity or a single merged row', () => {
      render([tool('a'), tool('b')]);
      expect(container.querySelector('[data-assistant-tools]')).toBeNull();
      render([
        thinking,
        ...['a', 'b'].map(
          (toolCallId): AssistantSegment => ({
            kind: 'tool',
            variant: 'agent_tool',
            toolName: 'read',
            toolCallId,
            title: 'Read',
          }),
        ),
      ]);
      expect(container.querySelector('[data-assistant-tools]')).toBeNull();
    });
  });

  describe('shared disclosure compatibility', () => {
    it('retains the existing uncontrolled collapseSignal behavior', () => {
      const renderDisclosure = (closed: boolean) =>
        act(() =>
          root.render(
            <AssistantDisclosure
              icon={null}
              title="Tool details"
              collapseSignal={closed}
            >
              Tool output
            </AssistantDisclosure>,
          ),
        );
      renderDisclosure(false);
      expect(button('Tool details').getAttribute('aria-expanded')).toBe(
        'false',
      );
      act(() => button('Tool details').click());
      expect(container.textContent).toContain('Tool output');
      renderDisclosure(true);
      expect(container.textContent).not.toContain('Tool output');
      act(() => button('Tool details').click());
      renderDisclosure(true);
      expect(container.textContent).toContain('Tool output');
    });

    it('delegates controlled expansion without overriding the supplied value', () => {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <AssistantDisclosure
            icon={null}
            title="Tool details"
            collapsed={false}
            onCollapsedChange={onChange}
          >
            Tool output
          </AssistantDisclosure>,
        ),
      );
      act(() => button('Tool details').click());
      expect(onChange).toHaveBeenCalledWith(true);
      expect(button('Tool details').getAttribute('aria-expanded')).toBe('true');
    });
  });

  it.each(['prose', 'completion'] as const)(
    'automatically collapses an untouched group on %s',
    (boundary) => {
      render();
      const originalHeader = header();
      render(
        boundary === 'prose'
          ? [...initial, { kind: 'text', text: 'The answer' }]
          : initial,
        { isStreaming: boundary !== 'completion' },
      );
      expect(header()).toBe(originalHeader);
      expect(header().getAttribute('aria-expanded')).toBe('false');
      expect(header().textContent).toBe('messages.activityCompletedSteps:3');
      expect(container.textContent).not.toContain('Read a');
      if (boundary === 'prose') {
        expect(
          container.querySelector('[data-prose-index="3"]')?.textContent,
        ).toBe('The answer');
      }
    },
  );

  it.each([true, false])(
    'preserves a manual collapsed=%s choice through streamed updates and completion',
    (collapsed) => {
      render();
      act(() => header().click());
      if (!collapsed) act(() => header().click());
      const originalHeader = header();
      const next: AssistantSegment[] = [
        ...initial,
        { kind: 'thinking', text: 'More progress' },
        tool('c'),
      ];
      render(next);
      expect(header()).toBe(originalHeader);
      expect(header().getAttribute('aria-expanded')).toBe(String(!collapsed));
      render([...next, { kind: 'text', text: 'Finished' }], {
        isStreaming: false,
      });
      expect(header()).toBe(originalHeader);
      expect(header().getAttribute('aria-expanded')).toBe(String(!collapsed));
    },
  );

  it('keeps inspected tool details and keyboard focus visible on completion', () => {
    render();
    const toolHeader = button('Read a');
    act(() => {
      toolHeader.focus();
      toolHeader.click();
    });
    expect(container.textContent).toContain('Output a');
    render([...initial, { kind: 'text', text: 'Finished' }], {
      isStreaming: false,
    });
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(button('Read a')).toBe(toolHeader);
    expect(document.activeElement).toBe(toolHeader);
    expect(container.textContent).toContain('Output a');
  });

  it('starts historical activity collapsed and can still reveal each call', () => {
    render([tool('a', 'Read file'), tool('b', 'Read file')], {
      isStreaming: false,
    });
    expect(header().getAttribute('aria-expanded')).toBe('false');
    act(() => header().click());
    const calls = [...container.querySelectorAll('button')].filter(
      (element) => element.textContent === 'Read file',
    );
    expect(calls).toHaveLength(2);
    act(() => calls.forEach((element) => element.click()));
    expect(container.textContent).toContain('Output a');
    expect(container.textContent).toContain('Output b');
  });

  it.each(['pending', 'in_progress', 'failed', undefined] as const)(
    'labels a normally ended group completed even when a tool status is %s',
    (status) => {
      render([tool('a'), { ...tool('b'), status }], { isStreaming: false });
      expect(header().textContent).toBe('messages.activityCompletedSteps:2');
    },
  );

  it.each<AssistantSegment[]>([
    [tool('a')],
    [{ kind: 'thinking', text: 'One thought' }],
    [{ kind: 'thinking', text: ' \n' }, tool('a')],
  ])(
    'does not add an outer disclosure for a single visible row %#',
    (...segments) => {
      render(segments, { isStreaming: false });
      expect(container.querySelector('[data-assistant-activity]')).toBeNull();
      expect(container.textContent).toMatch(/Read a|One thought/);
    },
  );

  it('keeps a live indicator for a singleton or empty thinking placeholder', () => {
    render([tool('a')]);
    expect(container.querySelector('[data-assistant-activity]')).toBeNull();
    expect(container.querySelector('[data-thinking-indicator]')).not.toBeNull();
    render([{ kind: 'thinking', text: '' }]);
    expect(container.querySelector('[data-thinking-indicator]')).not.toBeNull();
  });

  it('does not remount inspected output when a second visible row creates a group', () => {
    render([tool('a')]);
    const original = button('Read a');
    expect(original.querySelectorAll('svg')).toHaveLength(1);
    act(() => {
      original.focus();
      original.click();
    });
    render([tool('a'), tool('b')]);
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(button('Read a')).toBe(original);
    expect(original.querySelectorAll('svg')).toHaveLength(2);
    expect(document.activeElement).toBe(original);
    expect(container.textContent).toContain('Output a');
    render([tool('a'), tool('b')], { isStreaming: false });
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Output a');
  });

  it('summarizes confirmed file changes and the end of a group containing a failed read', () => {
    render(
      [
        {
          ...tool('edit'),
          toolKind: 'edit',
          content: [
            { type: 'diff', path: 'example.ts', oldText: 'a', newText: 'b' },
          ],
        },
        { ...tool('read'), status: 'failed' },
      ],
      { isStreaming: false },
    );
    expect(header().textContent).toBe(
      'messages.activityFilesChanged:1 · messages.activityCompletedSteps:2',
    );
  });

  it('closes the previous block and opens only the new trailing activity', () => {
    render();
    render([
      ...initial,
      { kind: 'text', text: 'Interim answer' },
      tool('c'),
      { kind: 'thinking', text: 'Next operation' },
    ]);
    expect(header(0).getAttribute('aria-expanded')).toBe('false');
    expect(header(1).getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Interim answer');
    expect(container.textContent).toContain('Read c');
  });

  it('keeps permissions visible and suppresses waiting spinners and message actions', () => {
    render([
      ...initial,
      { kind: 'text', text: 'Requesting approval' },
      {
        kind: 'permission',
        requestId: 'permission-1',
        toolCall: { title: 'Approve file write' },
        options: [],
      },
    ]);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Approve file write');
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull();
    expect(
      container.querySelector('[aria-label="messages.copyMessage"]'),
    ).toBeNull();
  });

  it.each(['error', 'interrupted'] as const)(
    'preserves a terminal %s while transport cleanup is still in progress',
    (endStatus) => {
      render(initial, { isStreaming: true, endStatus });
      expect(header().textContent).toBe(
        `messages.activity${endStatus === 'error' ? 'Error' : 'Interrupted'}Steps:3`,
      );
      expect(header().getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[data-thinking-indicator]')).toBeNull();
    },
  );

  it('keeps inline interruptions separate and does not relabel earlier completed groups', () => {
    render([
      ...initial,
      { kind: 'text', text: 'Finished this part' },
      tool('c'),
      { kind: 'thinking', text: 'Another step' },
      { kind: 'status', status: 'interrupted', detail: 'Stopped by user' },
    ]);
    expect(header(0).textContent).toBe('messages.activityCompletedSteps:3');
    expect(header(1).textContent).toBe('messages.activityInterruptedSteps:2');
    expect(container.textContent).toContain('Stopped by user');
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull();
  });

  it('does not mark a permission-blocked group completed', () => {
    render([
      ...initial,
      {
        kind: 'permission',
        requestId: 'p',
        toolCall: { title: 'Approval needed' },
        options: [],
      },
    ]);
    expect(header().textContent).toBe('messages.activitySteps:3');
    expect(container.textContent).toContain('Approval needed');
  });

  it('preserves prose comment indices, copy, and Add as note after task_complete projection', () => {
    render(
      [
        ...initial,
        { kind: 'text', text: 'First answer' },
        tool('c'),
        {
          ...tool('complete', 'task_complete'),
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Final answer' },
            },
          ],
        },
      ],
      { isStreaming: false, enableComments: true },
    );
    expect(
      [...container.querySelectorAll('[data-prose-index]')].map((element) => [
        element.getAttribute('data-prose-index'),
        element.getAttribute('data-comments'),
        element.textContent,
      ]),
    ).toEqual([
      ['3', 'true', 'First answer'],
      ['5', 'true', 'Final answer'],
    ]);
    act(() => button('messages.copyMessage').click());
    act(() => button('messages.addAsNote').click());
    expect(copy).toHaveBeenCalledWith('First answerFinal answer');
    expect(addNode).toHaveBeenCalledWith({
      nodeType: 'note',
      data: {
        content: 'First answerFinal answer',
        origin: { type: 'user-from-chat', threadId: 'thread-1' },
      },
    });
  });
});
