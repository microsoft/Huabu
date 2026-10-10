// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider, type ChatSession } from '@/hooks/useChatSession';
import en from '@/i18n/resources/en/common.json';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadPendingAttachments,
  useChatStore,
} from '@/store/chatStore';

import { NodeMentionMenu } from './NodeMentionMenu';
import {
  parseNodeMention,
  useNodeMentionTypeahead,
} from './useNodeMentionTypeahead';

const translations = createInstance();
void translations.init({ lng: 'en', resources: { en: { translation: en } } });
const session: ChatSession = {
  canvasId: 'canvas',
  ownerCanvasId: 'canvas',
  threadId: 'thread',
  conversationView: null,
};
let root: Root;
let container: HTMLDivElement;
let mention: ReturnType<typeof useNodeMentionTypeahead>;
let setDraft: (value: string) => void;
const onCommit = vi.fn();
const onSubmit = vi.fn();

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('');
  setDraft = setValue;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  mention = useNodeMentionTypeahead({
    value,
    onChange: setValue,
    onCommit,
    textareaRef,
    disabled,
  });
  return (
    <>
      <textarea
        ref={textareaRef}
        value={value}
        readOnly
        onFocus={mention.onFocus}
        onBlur={mention.onBlur}
        onKeyDown={(event) => {
          if (mention.handleKeyDown(event)) return;
          if (event.key === 'Enter' && !event.nativeEvent.isComposing)
            onSubmit();
        }}
      />
      {mention.open ? <NodeMentionMenu mention={mention} /> : null}
    </>
  );
}

function render(owner = session, disabled = false) {
  act(() =>
    root.render(
      <I18nextProvider i18n={translations}>
        <ChatSessionProvider value={owner}>
          <Harness disabled={disabled} />
        </ChatSessionProvider>
      </I18nextProvider>,
    ),
  );
}

function input() {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Missing textarea');
  return textarea;
}

function type(value: string, caret = value.length, end = caret) {
  act(() => setDraft(value));
  act(() => {
    input().focus();
    input().setSelectionRange(caret, end);
    mention.syncCaret();
  });
}

function key(key: string, options: KeyboardEventInit = {}) {
  act(() =>
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  useChatStore.setState({ threadsById: {}, selectionAttachment: null });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas',
    nodes: ['Other Herd', 'Herdr', 'Herdr notes', '研究笔记'].map(
      (label, index) => ({
        id: `node-${index}`,
        type: index === 1 ? 'frame' : 'note',
        position: { x: 0, y: 0 },
        data: { label },
      }),
    ),
    edges: [],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onCommit.mockClear();
  onSubmit.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('parseNodeMention', () => {
  it.each(['email@host', 'https://host/@name', 'hello', '@name ', '@@name'])(
    'does not activate for %s',
    (value) => {
      expect(parseNodeMention(value, value.length)).toBeNull();
    },
  );
  it('finds mentions at the start, after punctuation, and in Chinese sentences', () => {
    expect(parseNodeMention('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(parseNodeMention('对比 @研究', 6)).toEqual({
      start: 3,
      end: 6,
      query: '研究',
    });
    expect(parseNodeMention('(@Her)', 5)).toEqual({
      start: 1,
      end: 5,
      query: 'Her',
    });
  });
  it('replaces the full active token without consuming the remaining sentence', () => {
    expect(parseNodeMention('Compare @Herd and notes', 11)).toEqual({
      start: 8,
      end: 13,
      query: 'He',
    });
    expect(parseNodeMention('@Her', 1, 4)).toBeNull();
  });
});

describe('node mention typeahead', () => {
  it('keeps all matches accessible while mounting a bounded window', () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: Array.from({ length: 2000 }, (_, index) => ({
        id: `large-${index}`,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: `Entry ${index}` },
      })),
    });
    render();
    type('@');
    expect(mention.matches).toHaveLength(2000);
    expect(
      container.querySelectorAll('[role="option"]').length,
    ).toBeLessThanOrEqual(16);
    key('ArrowUp');
    expect(mention.activeIndex).toBe(1999);
    const active = document.getElementById(mention.activeOptionId ?? '');
    expect(active?.getAttribute('aria-posinset')).toBe('2000');
    expect(active?.getAttribute('aria-setsize')).toBe('2000');
    expect(
      container.querySelectorAll('[role="option"]').length,
    ).toBeLessThanOrEqual(16);
    key('ArrowDown');
    expect(mention.activeIndex).toBe(0);
    type('@Entry1999');
    expect(mention.matches).toHaveLength(0);
    type('@1999');
    expect(mention.matches.map(({ node }) => node.id)).toEqual(['large-1999']);
    key('Enter');
    expect(input().value).toBe('@Entry 1999 ');
  });

  it('ranks title prefixes first, keeps the full mention and stages an exact node reference', () => {
    render();
    type('Compare @her');
    expect(mention.matches.map((item) => item.label)).toEqual([
      'Herdr',
      'Herdr notes',
      'Other Herd',
    ]);
    key('Enter');
    expect(input().value).toBe('Compare @Herdr ');
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'thread'),
    ).toEqual([
      {
        type: 'text',
        source: 'selection',
        originNodeId: 'node-1',
        label: 'Herdr',
      },
    ]);
    expect(mention.open).toBe(false);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('supports keyboard wrapping, Tab, middle-of-draft insertion and deduplication', () => {
    render();
    type('Compare @Her and notes', 12);
    key('ArrowUp');
    expect(mention.activeIndex).toBe(2);
    key('ArrowDown');
    expect(mention.activeIndex).toBe(0);
    key('Tab');
    expect(input().value).toBe('Compare @Herdr and notes');
    type('@Her');
    key('Enter');
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'thread'),
    ).toHaveLength(1);
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'other'),
    ).toEqual([]);
  });
  it('adds a separate node reference without replacing an excerpt from that node', () => {
    useChatStore.getState().addPendingAttachment('thread', {
      type: 'text',
      source: 'excerpt',
      originNodeId: 'node-1',
      content: 'An excerpt',
    });
    render();
    type('@Her');
    key('Enter');
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'thread'),
    ).toHaveLength(2);
  });
  it('dismisses with Escape and reopens for a changed query', () => {
    render();
    type('@Her');
    key('Escape');
    expect(mention.open).toBe(false);
    act(() => mention.syncCaret());
    expect(mention.open).toBe(false);
    type('@Herd');
    expect(mention.open).toBe(true);
    act(() => input().blur());
    expect(mention.open).toBe(false);
  });
  it('shows an empty result and does not accidentally send on Enter', () => {
    render();
    type('@missing');
    expect(container.textContent).toContain('No matching nodes');
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe('@missing');
    key('Tab');
    expect(mention.open).toBe(false);
  });
  it('does not select during IME composition or when disabled or on another Canvas', () => {
    render();
    type('@研');
    key('Enter', { isComposing: true });
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'thread'),
    ).toEqual([]);
    act(() => mention.onCompositionStart());
    expect(mention.open).toBe(false);
    act(() => mention.onCompositionEnd());
    expect(mention.open).toBe(true);
    render(session, true);
    expect(mention.open).toBe(false);
    render({ ...session, canvasId: 'different-canvas' });
    expect(mention.open).toBe(false);
  });
  it('supports mouse selection and preserves the draft when its chip is removed', () => {
    render();
    type('@研究');
    const option =
      container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(option).not.toBeNull();
    act(() => option?.click());
    expect(input().value).toBe('@研究笔记 ');
    act(() => useChatStore.getState().removePendingAttachment('thread', 0));
    expect(input().value).toBe('@研究笔记 ');
  });
});
