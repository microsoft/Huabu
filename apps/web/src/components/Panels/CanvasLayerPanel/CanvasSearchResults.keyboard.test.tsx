// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import {
  act,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enCommon from '@/i18n/resources/en/common.json';
import zhCNCommon from '@/i18n/resources/zh-CN/common.json';
import { usePreviewSearchStore } from '@/store/previewSearchStore';
import { useSearchStore, type SearchResultRow } from '@/store/searchStore';

import { CanvasSearchResults } from './CanvasSearchResults';

import type * as SearchDom from '@/hooks/searchDom';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const {
  selectNodes,
  openPreviewNode,
  canvasState,
  scheduleScrollToMatch,
  toast,
  virtualization,
} = vi.hoisted(() => {
  const selectNodes = vi.fn();
  const nodes: { id: string; data: { threadId?: string; content?: string } }[] =
    [];
  return {
    selectNodes,
    openPreviewNode: vi.fn(),
    canvasState: {
      selectNodes,
      nodes,
      rfInstance: null,
      canvasWrapper: null,
    },
    scheduleScrollToMatch: vi.fn<typeof SearchDom.scheduleScrollToMatch>(),
    toast: vi.fn(),
    virtualization: {
      enabled: false,
      beforeDone: undefined as (() => void) | undefined,
    },
  };
});

vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (select: (state: typeof canvasState) => unknown) => select(canvasState),
    { getState: () => canvasState },
  ),
}));
vi.mock('@/store/previewWorkspace/store', () => ({
  selectActiveNodeId: () => null,
  usePreviewWorkspaceStore: () => null,
}));
vi.mock('@/store/previewWorkspace/actions', () => ({ openPreviewNode }));
vi.mock('@/hooks/useTextHighlight', () => ({ useTextHighlight: vi.fn() }));
vi.mock('@/hooks/searchDom', () => ({ scheduleScrollToMatch }));
vi.mock('../../Common/Toast', () => ({ toast }));
vi.mock('./LayerNodeIcon', () => ({ CanvasSearchNodeIcon: () => null }));
vi.mock('@/utils/canvasViewport', () => ({ revealNodesOnCanvas: vi.fn() }));
vi.mock('../../Nodes/previews', () => ({ hasNodePreview: () => true }));
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    ref,
    data,
    itemContent,
    computeItemKey,
  }: {
    ref: Ref<{
      scrollIntoView: (location: { index: number; done?: () => void }) => void;
    }>;
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey: (index: number, item: unknown) => string;
  }) => {
    const [target, setTarget] = useState(0);
    const pendingDone = useRef<(() => void) | undefined>(undefined);
    useImperativeHandle(ref, () => ({
      scrollIntoView: ({ index, done }) => {
        if (!virtualization.enabled) {
          done?.();
          return;
        }
        pendingDone.current = done;
        setTarget(index);
      },
    }));
    useLayoutEffect(() => {
      virtualization.beforeDone?.();
      pendingDone.current?.();
      pendingDone.current = undefined;
    }, [target]);
    return (
      <div>
        {data.map(
          (item, index) =>
            (!virtualization.enabled || index === target || index === 0) && (
              <div key={computeItemKey(index, item)}>
                {itemContent(index, item)}
              </div>
            ),
        )}
      </div>
    );
  },
}));

const results: SearchResultRow[] = ['first', 'second'].map((nodeId) => ({
  key: `${nodeId}:content:0`,
  tier: 'content',
  match: {
    nodeId,
    nodeType: 'note',
    label: nodeId,
    field: 'content',
    snippet: 'test content',
    matchStart: 0,
    matchLength: 4,
    occurrenceIndex: 0,
  },
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let searchInput: HTMLInputElement | undefined;
const testI18n = createInstance();

function getRow(index: number): HTMLButtonElement {
  const row = container?.querySelector<HTMLButtonElement>(
    `[data-search-row-index="${index}"]`,
  );
  if (!row) throw new Error(`Missing search row ${index}`);
  return row;
}

function press(element: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => element.dispatchEvent(event));
  return event;
}

beforeEach(async () => {
  virtualization.enabled = false;
  virtualization.beforeDone = undefined;
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    resources: {
      en: { common: enCommon },
      'zh-CN': { common: zhCNCommon },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  canvasState.nodes.splice(0);
  useSearchStore.setState({
    query: 'test',
    results,
    scope: { kind: 'canvas', canvasId: 'canvas' },
    collapsedNodeIds: new Set(),
    isStreaming: false,
    error: null,
    truncated: false,
    contentPhase: false,
  });
  container = document.createElement('div');
  searchInput = document.createElement('input');
  searchInput.dataset.canvasSearchInput = '';
  document.body.append(searchInput, container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <I18nextProvider i18n={testI18n}>
        <CanvasSearchResults />
      </I18nextProvider>,
    ),
  );
  vi.clearAllMocks();
});

describe('virtualized result focus ownership', () => {
  it.each(['append', 'regroup'] as const)(
    'retains the focused result by stable key during streaming (%s)',
    (change) => {
      act(() => getRow(3).focus());
      const focused = document.activeElement;
      const row: SearchResultRow = {
        ...results[0],
        key: 'first:summary:0',
        tier: 'meta',
        match: { ...results[0].match, field: 'summary' },
      };
      act(() =>
        useSearchStore.setState({
          isStreaming: true,
          results: change === 'append' ? [...results, row] : [row, ...results],
        }),
      );
      const index = 4;
      expect(document.activeElement).toBe(getRow(index));
      expect(document.activeElement?.textContent).toContain('test content');
      expect(document.activeElement).not.toBe(getRow(0));
      expect(document.activeElement).toBe(focused);
      press(getRow(index), 'Enter');
      expect(openPreviewNode).toHaveBeenLastCalledWith(
        'second',
        expect.objectContaining({ focusEditor: false }),
      );
    },
  );

  it.each([false, true])(
    'restores an unmounted result without overriding outside focus (%s)',
    (moveOutside) => {
      virtualization.enabled = true;
      const rows = Array.from({ length: 80 }, (_, i) => ({
        ...results[0],
        key: `first:content:${i}`,
        match: { ...results[0].match, occurrenceIndex: i },
      }));
      act(() => useSearchStore.setState({ results: rows }));
      act(() => getRow(0).focus());
      for (let i = 0; i < 80; i++) {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement))
          throw new Error('Missing focused row');
        press(focused, 'ArrowDown');
      }
      const last = getRow(80);
      expect(document.activeElement).toBe(last);
      if (moveOutside) virtualization.beforeDone = () => searchInput?.focus();
      press(last, 'ArrowLeft');
      expect(last.isConnected).toBe(false);
      expect(document.activeElement).toBe(
        moveOutside ? searchInput : getRow(0),
      );
    },
  );
});

describe('Canvas search localization', () => {
  it.each([
    {
      language: 'en',
      empty: 'No matches',
      streaming: 'Searching note contents…',
      truncated:
        'The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.',
    },
    {
      language: 'zh-CN',
      empty: '没有匹配结果',
      streaming: '正在搜索笔记正文…',
      truncated: '当前仅显示部分匹配结果，请使用更具体的搜索内容缩小范围。',
    },
  ])(
    'localizes empty, streaming, and truncated states in $language',
    async ({ language, empty, streaming, truncated }) => {
      await act(async () => {
        await testI18n.changeLanguage(language);
      });
      act(() => useSearchStore.setState({ results: [] }));
      expect(container?.textContent).toBe(empty);
      act(() =>
        useSearchStore.setState({ isStreaming: true, contentPhase: true }),
      );
      expect(container?.textContent).toBe(streaming);
      act(() => useSearchStore.setState({ truncated: true }));
      expect(container?.textContent).toContain(truncated);
    },
  );

  it('localizes every result field and switches language without resetting results', async () => {
    const fields = [
      'label',
      'summary',
      'keywords',
      'content',
      'conversation',
    ] as const;
    const fieldResults: SearchResultRow[] = fields.map((field) => ({
      ...results[0],
      key: `first:${field}:0`,
      match: { ...results[0].match, field },
    }));
    act(() => useSearchStore.setState({ results: fieldResults }));
    const getLabels = () =>
      Array.from(
        container?.querySelectorAll('[data-search-field] .uppercase') ?? [],
        (element) => element.textContent,
      );
    expect(getLabels()).toEqual([
      'Title',
      'Summary',
      'Keywords',
      'Content',
      'Conversation',
    ]);
    await act(async () => {
      await testI18n.changeLanguage('zh-CN');
    });
    expect(getLabels()).toEqual(['标题', '摘要', '关键词', '正文', '对话']);
    expect(useSearchStore.getState().results).toBe(fieldResults);
    expect(useSearchStore.getState().query).toBe('test');
  });

  it.each([
    {
      language: 'en',
      message:
        'Cannot precisely locate this match in the conversation. It may only exist in source text, or the content may have changed.',
    },
    {
      language: 'zh-CN',
      message:
        '无法在当前对话中精确定位此匹配；它可能仅存在于源码中，或内容已更新。',
    },
  ])(
    'localizes conversation match timeout feedback in $language',
    async ({ language, message }) => {
      await act(async () => {
        await testI18n.changeLanguage(language);
      });
      canvasState.nodes.push({ id: 'first', data: { threadId: 'thread' } });
      act(() =>
        useSearchStore.setState({
          results: [
            {
              ...results[0],
              match: { ...results[0].match, field: 'conversation' },
            },
          ],
        }),
      );
      act(() => getRow(1).click());
      const options = scheduleScrollToMatch.mock.calls[0]?.[3];
      expect(options?.onTimeout).toBeTypeOf('function');
      options?.onTimeout?.();
      expect(toast).toHaveBeenCalledExactlyOnceWith(message, {
        tone: 'info',
        duration: 4000,
      });
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  searchInput?.remove();
  root = undefined;
  useSearchStore.getState().close();
  usePreviewSearchStore.getState().close();
});

describe('Canvas search field groups and preview navigation', () => {
  it('does not activate a previous-query row during the next query debounce', () => {
    vi.useFakeTimers();
    try {
      const previousRow = getRow(1);
      act(() => useSearchStore.getState().setQuery('replacement'));
      expect(
        container?.querySelector('[data-search-row-index="1"]'),
      ).toBeNull();
      act(() => previousRow.click());
      expect(openPreviewNode).not.toHaveBeenCalled();
      expect(usePreviewSearchStore.getState().navigationRequest).toBeNull();
    } finally {
      act(() => useSearchStore.getState().close());
      vi.useRealTimers();
    }
  });

  it.each([' test', 'test ', ' test '])(
    'uses the server-normalized query for content and conversation handoffs (%j)',
    (query) => {
      act(() => useSearchStore.setState({ query }));
      act(() => getRow(1).click());
      const previewQuery = usePreviewSearchStore.getState().query;
      canvasState.nodes.push({ id: 'first', data: { threadId: 'thread' } });
      act(() =>
        useSearchStore.setState({
          results: [
            {
              ...results[0],
              match: {
                ...results[0].match,
                field: 'conversation',
                nodeType: 'question',
              },
            },
          ],
        }),
      );
      act(() => getRow(1).click());
      expect({
        previewQuery,
        conversationQuery: scheduleScrollToMatch.mock.lastCall?.[1],
      }).toEqual({ previewQuery: 'test', conversationQuery: 'test' });
    },
  );

  it('opens Question prompt-content matches in their conversation rather than a document preview', () => {
    canvasState.nodes.push({ id: 'first', data: { threadId: 'thread' } });
    act(() =>
      useSearchStore.setState({
        results: [
          {
            ...results[0],
            match: {
              ...results[0].match,
              nodeType: 'question',
              occurrenceIndex: 1,
            },
          },
        ],
      }),
    );
    act(() => getRow(1).click());
    expect(openPreviewNode).toHaveBeenCalledExactlyOnceWith('first');
    expect(scheduleScrollToMatch).toHaveBeenCalledWith(
      expect.any(Function),
      'test',
      1,
      expect.any(Object),
    );
    expect(usePreviewSearchStore.getState().isOpen).toBe(false);
  });

  it('scopes Question body ordinals to a unique originating prompt, not the full thread or quoted content', () => {
    canvasState.nodes.push({
      id: 'first',
      data: { threadId: 'thread', content: ' recent test test ' },
    });
    act(() =>
      useSearchStore.setState({
        results: [
          {
            ...results[0],
            match: {
              ...results[0].match,
              nodeType: 'question',
              occurrenceIndex: 1,
            },
          },
        ],
      }),
    );
    act(() => getRow(1).click());
    const getMatchRoot = scheduleScrollToMatch.mock.lastCall?.[3]?.getMatchRoot;
    expect(getMatchRoot).toBeTypeOf('function');
    const thread = document.createElement('div');
    thread.innerHTML =
      '<div><span data-chat-prompt-content>earlier test</span></div><div><span>quoted test</span><span data-chat-prompt-content>recent test test</span></div>';
    const prompt = thread.querySelectorAll<HTMLElement>(
      '[data-chat-prompt-content]',
    )[1];
    expect(getMatchRoot?.(thread)).toBe(prompt);
    thread.insertAdjacentHTML(
      'beforeend',
      '<span data-chat-prompt-content>recent test test</span>',
    );
    expect(getMatchRoot?.(thread)).toBeNull();
    thread.innerHTML = '<span data-chat-prompt-content>earlier test</span>';
    expect(getMatchRoot?.(thread)).toBeNull();
  });

  it('groups interleaved matches by field and labels each field only once', () => {
    const rows: SearchResultRow[] = [
      results[0],
      {
        ...results[0],
        key: 'first:summary:0',
        match: { ...results[0].match, field: 'summary' },
      },
      {
        ...results[0],
        key: 'first:content:1',
        match: { ...results[0].match, occurrenceIndex: 1 },
      },
    ];
    act(() => useSearchStore.setState({ results: rows }));
    expect(
      Array.from(
        container?.querySelectorAll('[data-search-field]') ?? [],
        (element) => element.getAttribute('data-search-field'),
      ),
    ).toEqual(['content', 'content', 'summary']);
    expect(
      Array.from(
        container?.querySelectorAll('.uppercase') ?? [],
        (element) => element.textContent,
      ),
    ).toEqual(['Content', 'Summary']);
    act(() => getRow(2).focus());
    press(getRow(2), 'Enter');
    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'first',
      query: 'test',
      isOpen: true,
      focusInput: false,
      navigationRequest: { occurrenceIndex: 1 },
    });
  });

  it('hands the clicked content match to preview search without stealing result focus', () => {
    act(() => getRow(3).focus());
    act(() => getRow(3).click());
    expect(openPreviewNode).toHaveBeenCalledExactlyOnceWith('second', {
      transient: true,
      focusEditor: false,
    });
    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'second',
      query: 'test',
      isOpen: true,
      focusInput: false,
      navigationRequest: { occurrenceIndex: 0 },
    });
    expect(document.activeElement).toBe(getRow(3));
  });

  it('cancels a pending conversation jump when activating another result or closing search', () => {
    const cancel = vi.fn();
    scheduleScrollToMatch.mockReturnValue(cancel);
    canvasState.nodes.push({ id: 'first', data: { threadId: 'thread' } });
    act(() =>
      useSearchStore.setState({
        results: [
          {
            ...results[0],
            match: { ...results[0].match, field: 'conversation' },
          },
          results[1],
        ],
      }),
    );
    act(() => getRow(1).click());
    act(() => getRow(3).click());
    expect(cancel).toHaveBeenCalledTimes(1);
    act(() => getRow(1).click());
    act(() => useSearchStore.getState().close());
    expect(cancel).toHaveBeenCalledTimes(2);
    scheduleScrollToMatch.mockReset();
  });
});

describe('Canvas search keyboard focus', () => {
  it('activates the second group when its header receives Tab focus', () => {
    const second = getRow(2);
    act(() => second.focus());
    press(second, 'Enter');
    expect(useSearchStore.getState().collapsedNodeIds.has('second')).toBe(true);
    expect(useSearchStore.getState().collapsedNodeIds.has('first')).toBe(false);
  });

  it('moves actual result focus with arrow navigation before Enter activation', () => {
    act(() => getRow(0).focus());
    press(getRow(0), 'ArrowDown');
    expect(document.activeElement).toBe(getRow(1));
    press(getRow(1), 'Enter');
    expect(openPreviewNode).toHaveBeenCalledExactlyOnceWith('first', {
      transient: true,
      focusEditor: false,
    });
    expect(useSearchStore.getState().collapsedNodeIds.size).toBe(0);
    press(getRow(1), 'ArrowDown');
    expect(document.activeElement).toBe(getRow(2));
    press(getRow(2), 'Enter');
    expect(useSearchStore.getState().collapsedNodeIds.has('second')).toBe(true);
  });

  it('keeps virtual result navigation in the search input without moving DOM focus', () => {
    if (!searchInput) throw new Error('Missing search input');
    act(() => searchInput?.focus());
    press(searchInput, 'ArrowDown');
    expect(document.activeElement).toBe(searchInput);
    press(searchInput, 'Enter');
    expect(openPreviewNode).toHaveBeenCalledExactlyOnceWith('first', {
      transient: true,
      focusEditor: false,
    });
  });

  it('continues arrow navigation from a clicked match', () => {
    act(() => getRow(3).click());
    expect(openPreviewNode).toHaveBeenCalledWith('second', {
      transient: true,
      focusEditor: false,
    });
    if (!searchInput) throw new Error('Missing search input');
    act(() => searchInput?.focus());
    press(searchInput, 'ArrowUp');
    press(searchInput, 'Enter');
    expect(useSearchStore.getState().collapsedNodeIds.has('second')).toBe(true);
    expect(useSearchStore.getState().collapsedNodeIds.has('first')).toBe(false);
  });

  it('does not consume Enter from unrelated controls', () => {
    const other = document.createElement('button');
    document.body.appendChild(other);
    try {
      act(() => other.focus());
      expect(press(other, 'Enter').defaultPrevented).toBe(false);
      expect(useSearchStore.getState().collapsedNodeIds.size).toBe(0);
      expect(selectNodes).not.toHaveBeenCalled();
    } finally {
      other.remove();
    }
  });
});
