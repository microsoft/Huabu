// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  selectThreadDraft,
  selectThreadQuotedComments,
  useChatStore,
} from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import { MilkdownMessageCard } from './MilkdownMessageCard';

import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';

const preview = vi.hoisted(() => ({
  addNode: vi.fn(),
  onTextSelection: undefined as
    | ((selection: MilkdownPreviewSelection | null) => void)
    | undefined,
}));
vi.mock('@/components/Milkdown', () => ({
  MilkdownPreview: ({
    onTextSelection,
  }: {
    onTextSelection?: typeof preview.onTextSelection;
  }) => {
    preview.onTextSelection = onTextSelection;
    return <div>Answer</div>;
  },
}));
vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (selector: (state: { canvasId: string | null }) => unknown) =>
      selector({ canvasId: null }),
    { getState: () => ({ addNode: preview.addNode }) },
  ),
}));
vi.mock('@/utils/io/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const selection: MilkdownPreviewSelection = {
  range: { from: 1, to: 8 },
  text: 'selected\n\npassage',
  markdown: '**selected**\n\npassage',
  contextBefore: 'Before ',
  contextAfter: ' after',
  position: { x: 20, y: 20 },
};
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  preview.addNode.mockClear();
  vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
  useChatStore.setState({ threadsById: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(enabled = true, content = 'Original answer') {
  act(() =>
    root.render(
      <MilkdownMessageCard
        content={content}
        threadId="thread-a"
        messageId="answer-1"
        enableComments={enabled}
      />,
    ),
  );
}
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(
    (item) =>
      item.textContent?.trim() === name ||
      item.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
function click(name: string) {
  act(() => button(name).click());
}
function input() {
  const element = document.querySelector<HTMLInputElement>(
    'input[aria-label="Comment"]',
  );
  if (!element) throw new Error('Missing comment editor');
  return element;
}
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function select() {
  act(() => preview.onTextSelection?.(selection));
  click('Comment');
}

describe('AI response comments', () => {
  it('copies only the selected plain text without writing a note or changing the draft', async () => {
    useChatStore.getState().setDraft('thread-a', 'Keep my draft.');
    render();
    act(() => preview.onTextSelection?.(selection));
    await act(async () => button('Copy').click());
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(selection.text);
    expect(preview.addNode).not.toHaveBeenCalled();
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe(
      'Keep my draft.',
    );
    expect(document.querySelector('button[aria-label="Comment"]')).toBeNull();
  });

  it('surfaces clipboard failures and allows retrying the same snapshot', async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(
      new Error('Clipboard unavailable'),
    );
    render();
    act(() => preview.onTextSelection?.(selection));
    await act(async () => button('Copy').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not copy',
    );
    expect(button('Copy').disabled).toBe(false);
    await act(async () => button('Copy').click());
    expect(copyToClipboard).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('saves the selected Markdown with the same note origin as the whole-response action', () => {
    render();
    act(() => preview.onTextSelection?.(selection));
    click('Add as note');
    expect(preview.addNode).toHaveBeenCalledExactlyOnceWith({
      nodeType: 'note',
      data: {
        content: selection.markdown,
        origin: { type: 'user-from-chat', threadId: 'thread-a' },
      },
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe('');
    expect(document.querySelector('button[aria-label="Comment"]')).toBeNull();
  });

  it('uses compact action buttons in the comment editor', () => {
    render();
    select();
    for (const name of ['Cancel', 'Add to input']) {
      expect(button(name).classList.contains('text-xs')).toBe(true);
      expect(button(name).classList.contains('py-1')).toBe(true);
      expect(button(name).classList.contains('px-2.5')).toBe(true);
    }
  });

  it('trims quote boundaries in the editor and draft without changing copied text', async () => {
    const text = ' \t\nselected  text\n\n    indented\npassage\n ';
    render();
    act(() => preview.onTextSelection?.({ ...selection, text }));
    await act(async () => button('Copy').click());
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(text);
    act(() => preview.onTextSelection?.({ ...selection, text }));
    click('Comment');
    expect(document.querySelector('blockquote')?.textContent).toBe(text.trim());
    type('Keep it.');
    click('Add to input');
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread-a'),
    ).toEqual([
      {
        quote: text.trim(),
        draftId: expect.any(String),
        contextBefore: selection.contextBefore,
        contextAfter: selection.contextAfter,
        comment: 'Keep it.',
      },
    ]);
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe('');
  });

  it.each([
    ['en', 'Quoted passage', 'Add a comment…'],
    ['zh-CN', '引用内容', '添加评论…'],
  ])(
    'labels the quoted passage and uses a concise placeholder in %s',
    async (language, label, placeholder) => {
      await i18n.changeLanguage(language);
      render();
      act(() => preview.onTextSelection?.(selection));
      click(i18n.t('messages.fragmentComment'));
      expect(
        document.querySelector('figcaption svg.lucide-quote'),
      ).not.toBeNull();
      expect(
        document.querySelector('figcaption svg')?.getAttribute('aria-hidden'),
      ).toBe('true');
      expect(document.querySelector('figcaption .sr-only')?.textContent).toBe(
        label,
      );
      const quote = document.querySelector('figure blockquote');
      expect(quote?.textContent).toBe(selection.text);
      expect(quote?.classList.contains('text-xs')).toBe(true);
      expect(quote?.classList.contains('wrap-anywhere')).toBe(true);
      expect(quote?.classList.contains('border-l-2')).toBe(false);
      expect(document.querySelector('figure')?.classList.contains('flex')).toBe(
        true,
      );
      expect(document.querySelector('input')?.placeholder).toBe(placeholder);
    },
  );

  it('opens a snapshot editor, requires a comment and cancels without changing the draft', () => {
    render();
    select();
    expect(document.querySelector('blockquote')?.textContent).toBe(
      selection.text,
    );
    expect(button('Add to input').disabled).toBe(true);
    type('   ');
    expect(button('Add to input').disabled).toBe(true);
    type('Keep it.');
    click('Cancel');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe('');
    expect(document.querySelector('blockquote')).toBeNull();
  });

  it('stages multiple quoted comments in the owning thread without rewriting text or sending', () => {
    const addMessage = vi.spyOn(useChatStore.getState(), 'addMessage');
    useChatStore.getState().setDraft('thread-a', 'Before opening');
    useChatStore.getState().setDraft('thread-b', 'Other thread');
    render();
    select();
    type('Keep it.');
    act(() =>
      useChatStore.getState().setDraft('thread-a', 'Edited while commenting'),
    );
    click('Add to input');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe(
      'Edited while commenting',
    );
    expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
      'thread-a',
    );
    select();
    type('请展开');
    click('Add to input');
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread-a').map(
        (item) => item.comment,
      ),
    ).toEqual(['Keep it.', '请展开']);
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread-b'),
    ).toEqual([]);
    expect(selectThreadDraft(useChatStore.getState(), 'thread-b')).toBe(
      'Other thread',
    );
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('keeps capture-time text after focus and source changes and never rewrites emitted input', () => {
    render();
    select();
    act(() => preview.onTextSelection?.(null));
    render(true, 'Replaced answer');
    type('Explore this.');
    click('Add to input');
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread-a')[0]?.quote,
    ).toBe(selection.text);
    act(() =>
      useChatStore
        .getState()
        .setDraft('thread-a', 'Manually edited comment\nFinal instruction'),
    );
    render(true, 'Changed again');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe(
      'Manually edited comment\nFinal instruction',
    );
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread-a')[0]?.quote,
    ).toBe(selection.text);
  });

  it('does not emit during Chinese IME composition', () => {
    render();
    select();
    type('你好');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'isComposing', { value: true });
    act(() => input().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe('');
  });

  it('disables selection feedback on inactive or streaming surfaces and resets the editor', () => {
    render();
    select();
    render(false);
    expect(preview.onTextSelection).toBeUndefined();
    expect(document.querySelector('blockquote')).toBeNull();
    render();
    expect(document.querySelector('blockquote')).toBeNull();
  });
});
