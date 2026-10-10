// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionProvider } from '@/hooks/useChatSession';
import en from '@/i18n/resources/en/common.json';
import zh from '@/i18n/resources/zh-CN/common.json';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadPendingAttachments,
  useChatStore,
} from '@/store/chatStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { ChatContextSources } from './ChatContextSources';

import type { ChatSession } from '@/hooks/useChatSession';
import type { ChatAttachment } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@/components/Common/NodeRef', () => ({
  NodeRef: ({ nodeId }: { nodeId: string }) => <span>{nodeId}</span>,
}));

const translations = createInstance();
void translations.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
});
const session: ChatSession = {
  canvasId: 'canvas-test',
  ownerCanvasId: 'canvas-test',
  threadId: 'thread-test',
  conversationView: null,
};
const excerpt = {
  type: 'text',
  source: 'excerpt',
  content: 'The exact passage selected by the user',
  originNodeId: 'note-1',
} satisfies ChatAttachment;
let root: Root;
let container: HTMLDivElement;

function node(id: string, options: Partial<Node> = {}): Node {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { label: id },
    ...options,
  };
}

function setNodes(nodes: Node[]) {
  act(() => useCanvasStore.getState()._setStateNoAutosave({ nodes }));
}

function render({
  owner = session,
  adjacentNodeSourceId,
  onCommit = vi.fn(),
}: {
  owner?: ChatSession;
  adjacentNodeSourceId?: string;
  onCommit?: () => void;
} = {}) {
  act(() =>
    root.render(
      <I18nextProvider i18n={translations}>
        <ChatSessionProvider value={owner}>
          <ChatContextSources
            adjacentNodeSourceId={adjacentNodeSourceId}
            onCommit={onCommit}
          />
        </ChatSessionProvider>
      </I18nextProvider>,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === label ||
      candidate.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

beforeEach(() => {
  void translations.changeLanguage('en');
  useChatStore.setState({ threadsById: {}, selectionAttachment: null });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: session.canvasId,
    nodes: [],
    edges: [],
  });
  useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ChatContextSources', () => {
  it('makes pinned and uploaded preview text focusable separately from removal', () => {
    useChatStore.getState().addPendingAttachment(session.threadId, excerpt);
    useChatStore.getState().addPendingAttachment(session.threadId, {
      type: 'file',
      source: 'upload',
      filename: 'notes.md',
      content: 'Uploaded text',
    });
    render();
    const previews = container.querySelectorAll<HTMLElement>(
      '[data-context-attachment] [tabindex="0"]:not(button)',
    );
    expect(previews).toHaveLength(2);
    act(() => previews[0].focus());
    expect(document.activeElement).toBe(previews[0]);
    expect(previews[0].getAttribute('aria-label')).toBe(excerpt.content);
    expect(previews[1].getAttribute('aria-label')).toBe('notes.md');
    expect(
      container.querySelectorAll('button[aria-label="Remove attachment"]'),
    ).toHaveLength(2);
  });

  it('renders nothing when no explicit context is available', () => {
    render();
    expect(container.childElementCount).toBe(0);
  });

  it('shows an automatic excerpt as included before the selected-node summary', () => {
    setNodes([
      node('note-1', { selected: true }),
      node('note-2', { selected: true }),
    ]);
    useChatStore.getState().setSelectionAttachment(excerpt);
    render();
    const included = container.querySelector('[role="group"]');
    expect(included?.getAttribute('aria-label')).toBe(
      'Included with your message',
    );
    expect(included?.textContent).toContain(excerpt.content);
    expect(container.textContent).toContain('2 selected nodes');
    expect(container.textContent?.indexOf(excerpt.content)).toBeLessThan(
      container.textContent?.indexOf('2 selected nodes') ?? -1,
    );
    expect(container.querySelector('.border-dashed')).toBeNull();
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([]);
    expect(button('Pin this excerpt to this chat').type).toBe('button');
    expect(button('Pin this excerpt to this chat').textContent).toBe(
      excerpt.content,
    );
    expect(
      button('Pin this excerpt to this chat').querySelector('svg.lucide-pin'),
    ).not.toBeNull();
    expect(container.querySelectorAll('svg:not(.lucide-pin)')).toHaveLength(0);
    expect(included?.textContent).not.toContain('Plus');
    expect(
      container.querySelectorAll('[data-context-attachment] button'),
    ).toHaveLength(1);
  });

  it('pins the full excerpt to this thread without losing subsequent selections', () => {
    useChatStore.getState().setSelectionAttachment(excerpt);
    const onCommit = vi.fn();
    render({ onCommit });
    act(() => button('Pin this excerpt to this chat').click());
    expect(useChatStore.getState().selectionAttachment).toBeNull();
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([excerpt]);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(excerpt.content);
    expect(
      container.querySelector('[aria-label="Pin this excerpt to this chat"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-context-attachment] button')
        ?.getAttribute('aria-label'),
    ).toBe('Remove attachment');
    expect(
      container.querySelectorAll('[data-context-attachment] button'),
    ).toHaveLength(1);

    act(() =>
      useChatStore
        .getState()
        .setSelectionAttachment({ ...excerpt, content: 'Next passage' }),
    );
    expect(
      container.querySelectorAll('[data-context-attachment]'),
    ).toHaveLength(2);
    render({ owner: { ...session, threadId: 'other-thread' } });
    expect(container.textContent).toContain('Next passage');
    expect(container.textContent).not.toContain(excerpt.content);
  });

  it('offers one leading action: pin the temporary excerpt, then remove it', () => {
    useChatStore.getState().setSelectionAttachment(excerpt);
    const onCommit = vi.fn();
    render({ onCommit });
    expect(
      container.querySelector('[aria-label="Remove attachment"]'),
    ).toBeNull();
    act(() => button('Pin this excerpt to this chat').click());
    act(() => button('Remove attachment').click());
    expect(useChatStore.getState().selectionAttachment).toBeNull();
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([]);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(container.childElementCount).toBe(0);
  });

  it('offers an adjacent node outside the included group until explicitly added', () => {
    setNodes([node('Adjacent note')]);
    const onCommit = vi.fn();
    render({ adjacentNodeSourceId: 'Adjacent note', onCommit });
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([]);
    const add = button('Add Adjacent note');
    expect(add.type).toBe('button');
    expect(add.textContent).toBe('Adjacent note');
    expect(add.querySelector('svg.lucide-plus')).not.toBeNull();
    expect(add.classList.contains('border-dashed')).toBe(true);
    expect(add.classList.contains('bg-transparent')).toBe(true);
    expect(add.classList.contains('px-1.5')).toBe(true);
    act(() => add.click());
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([
      {
        type: 'text',
        source: 'selection',
        originNodeId: 'Adjacent note',
        label: 'Adjacent note',
      },
    ]);
    expect(container.querySelector('[role="group"]')?.textContent).toContain(
      'Adjacent note',
    );
    expect(container.querySelector('svg.lucide-plus')).toBeNull();
    expect(container.querySelector('svg.lucide-x')).not.toBeNull();
    expect(container.textContent).not.toContain('Add Adjacent note');
    expect(onCommit).toHaveBeenCalledOnce();

    act(() => button('Remove attachment').click());
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(button('Add Adjacent note')).toBeDefined();
  });

  it.each([{ label: '' }, {}, { label: 42 }])(
    'preserves the adjacent candidate fallback when adding node data %j',
    (data) => {
      setNodes([node('untitled-node', { data })]);
      render({ adjacentNodeSourceId: 'untitled-node' });
      act(() => button('Add Untitled').click());
      expect(
        selectThreadPendingAttachments(
          useChatStore.getState(),
          session.threadId,
        ),
      ).toEqual([
        {
          type: 'text',
          source: 'selection',
          originNodeId: 'untitled-node',
          label: 'Untitled',
        },
      ]);
      expect(
        container.querySelector('[data-context-attachment]')?.textContent,
      ).toBe('Untitled');
    },
  );

  it('keeps the Canvas summary after excerpts, attachments and the adjacent candidate', () => {
    setNodes([node('selected', { selected: true }), node('Adjacent note')]);
    useChatStore.getState().setSelectionAttachment(excerpt);
    useChatStore.getState().addPendingAttachment(session.threadId, {
      type: 'file',
      source: 'upload',
      filename: 'notes.md',
    });
    render({ adjacentNodeSourceId: 'Adjacent note' });
    expect(container.textContent).toBe(
      `${excerpt.content}notes.mdAdjacent note1 selected node`,
    );
    expect(button('Add Adjacent note').closest('[role="group"]')).toBeNull();
    act(() => button('Add Adjacent note').click());
    expect(container.textContent).toBe(
      `${excerpt.content}notes.mdAdjacent note1 selected node`,
    );
  });

  it('does not offer nodes already selected through a Frame and excludes the anchor recursively', () => {
    setNodes([
      node('frame', { type: 'frame', selected: true }),
      node('child', { parentId: 'frame', selected: true }),
      node('question', { type: 'question', parentId: 'frame', selected: true }),
      node('ink', { type: 'sketch', parentId: 'frame' }),
    ]);
    useGesturePreviewStore.setState({
      sketchStrokeSelection: { ink: ['stroke-1'] },
    });
    const owner: ChatSession = {
      ...session,
      conversationView: {
        presentationAnchor: { canvasId: session.canvasId, nodeId: 'question' },
        conversationOwner: {
          canvasId: session.canvasId,
          nodeId: 'question',
          threadId: session.threadId,
        },
      },
    };
    render({ owner, adjacentNodeSourceId: 'child' });
    expect(container.textContent).toContain('3 selected nodes');
    expect(container.textContent).not.toContain('Add child');
    const summary = container.querySelector('[tabindex="0"]');
    expect(summary?.getAttribute('aria-label')).toBe(
      '3 selected sources: frame, child, ink',
    );

    setNodes([node('question', { type: 'question', selected: true })]);
    expect(container.childElementCount).toBe(0);
  });

  it('counts partial Sketch selections but not stale or non-Sketch stroke entries', () => {
    setNodes([node('ink', { type: 'sketch' }), node('note')]);
    useGesturePreviewStore.setState({
      sketchStrokeSelection: {
        ink: ['stroke-1'],
        missing: ['stroke-2'],
        note: ['stroke-3'],
      },
    });
    render();
    expect(container.textContent).toContain('1 selected node');
    act(() => useGesturePreviewStore.setState({ sketchStrokeSelection: {} }));
    expect(container.childElementCount).toBe(0);
  });

  it('does not display selection or a candidate from another Canvas', () => {
    setNodes([node('selected', { selected: true })]);
    render({
      owner: {
        ...session,
        canvasId: 'another-canvas',
        ownerCanvasId: 'another-canvas',
      },
      adjacentNodeSourceId: 'selected',
    });
    expect(container.childElementCount).toBe(0);
  });

  it('keeps uploaded image previews and removes only the current thread attachment', () => {
    const image: ChatAttachment = {
      type: 'image',
      source: 'upload',
      url: 'https://example.test/image.png',
      label: 'Diagram',
    };
    useChatStore.getState().addPendingAttachment(session.threadId, image);
    useChatStore.getState().addPendingAttachment('other-thread', excerpt);
    const onCommit = vi.fn();
    render({ onCommit });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image.url);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Diagram');
    act(() => button('Remove attachment').click());
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), session.threadId),
    ).toEqual([]);
    expect(
      selectThreadPendingAttachments(useChatStore.getState(), 'other-thread'),
    ).toEqual([excerpt]);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('localizes the unified source state in Chinese', async () => {
    await translations.changeLanguage('zh-CN');
    setNodes([node('note', { selected: true })]);
    useChatStore.getState().setSelectionAttachment(excerpt);
    render();
    expect(
      container.querySelector('[role="group"]')?.getAttribute('aria-label'),
    ).toBe('随消息发送');
    expect(container.textContent).toContain('1 个已选节点');
    expect(button('将此摘录固定到当前对话')).toBeDefined();
  });
});
