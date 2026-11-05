// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { getRecentCanvasConversation } from '@/api/canvas';
import {
  createMilkdown,
  type MilkdownInstance,
} from '@/components/Milkdown/createMilkdown';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore, selectThreadQuotedComments } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { NoteCommentActions } from './NoteCommentActions';

import type * as CanvasApi from '@/api/canvas';

vi.mock('@/api/canvas', async (original) => ({
  ...(await original<typeof CanvasApi>()),
  getRecentCanvasConversation: vi.fn(),
}));
vi.mock('@/hooks/useAcpProfiles', () => ({
  useAcpProfiles: () => ({
    profiles: [],
    loaded: true,
    error: null,
    refresh: vi.fn(),
  }),
}));
let editor: MilkdownInstance;
let editorRoot: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  vi.mocked(getRecentCanvasConversation).mockResolvedValue({
    conversation: null,
  });
  useCanvasStore.setState({
    canvasId: 'space',
    pendingForkThreadIds: {},
    nodes: [
      {
        id: 'note',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { content: 'original' },
      },
      {
        id: 'agent',
        type: 'question',
        position: { x: 0, y: 0 },
        data: {
          label: 'Reader',
          threadId: 'thread',
          agentMode: 'ask',
          status: 'running',
        },
      },
    ],
  });
  useChatStore.setState({ threadsById: {} });
  useChatStore.getState().setDraft('thread', 'Keep my instructions');
  usePanelStore.setState({
    isRightCollapsed: false,
    focusChatInputRequest: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'space',
    workspace: createEmptyWorkspace('group'),
  });
  usePreviewWorkspaceStore
    .getState()
    .openPreviewTarget({ kind: 'node', canvasId: 'space', nodeId: 'note' });
  editorRoot = document.createElement('div');
  document.body.append(editorRoot);
  editor = await createMilkdown({
    root: editorRoot,
    initialMarkdown: 'Before **selected** after.\n\nSecond paragraph.',
    toolbarMode: 'none',
  });
  editor.__selectTextBetweenForTest?.('selected', 'selected');
  vi.spyOn(editor, 'getSelectionClientRect').mockReturnValue(
    new DOMRect(20, 20, 100, 20),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  await editor.destroy();
  editorRoot.remove();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(mode: 'edit' | 'selection' = 'edit') {
  await act(async () =>
    root.render(
      <NoteCommentActions
        editor={editor}
        surfaceRef={{ current: editorRoot }}
        canvasId="space"
        nodeId="note"
        mode={mode}
      />,
    ),
  );
}
function commentButton() {
  const found = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Comment on selection"]',
  );
  if (!found) throw new Error('Missing comment action');
  return found;
}
function addButton() {
  const found = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add to input"]',
  );
  if (!found) throw new Error('Missing add action');
  return found;
}
function writeComment() {
  const input = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Comment"]',
  );
  if (!input) throw new Error('Missing comment editor');
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(input, 'Explain this');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it.each(['edit', 'selection'] as const)(
  'stages captured Note evidence only after a written comment is confirmed in %s mode',
  async (mode) => {
    await render(mode);
    const revision = nodeRevisionOf({ content: editor.getMarkdown() });
    const nodes = useCanvasStore.getState().nodes;
    expect(document.querySelectorAll('.canvas-context-toolbar')).toHaveLength(
      mode === 'edit' ? 2 : 1,
    );
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('.ink-agent-destination-trigger')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => commentButton().click());
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread'),
    ).toHaveLength(0);
    expect(addButton().disabled).toBe(true);
    writeComment();
    act(() => addButton().click());
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread'),
    ).toMatchObject([
      {
        quote: 'selected',
        comment: 'Explain this',
        contextBefore: 'Before ',
        contextAfter: ' after. Second paragraph.',
        source: {
          kind: 'note',
          canvasId: 'space',
          nodeId: 'note',
          snapshotRevision: revision,
        },
      },
    ]);
    expect(useChatStore.getState().threadsById.thread.draft).toBe(
      'Keep my instructions',
    );
    expect(useChatStore.getState().threadsById.thread.messages).toEqual([]);
    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
      'thread',
    );
    expect(usePreviewWorkspaceStore.getState().workspace.groups).toHaveLength(
      2,
    );
  },
);

it('blocks pending forks in the on-demand destination menu', async () => {
  await render();
  await act(async () => commentButton().click());
  act(() =>
    useCanvasStore.setState({
      pendingForkThreadIds: { thread: true },
    }),
  );
  writeComment();
  expect(addButton().disabled).toBe(true);
  expect(selectThreadQuotedComments(useChatStore.getState(), 'thread')).toEqual(
    [],
  );
});

it.each(['metaKey', 'ctrlKey'])(
  'does not edit the Note link from a comment with %s+K',
  async (modifier) => {
    const linkEditRequested = vi.fn();
    editor.onLinkEditRequested(linkEditRequested);
    await render();
    await act(async () => commentButton().click());
    writeComment();
    const input = document.querySelector('textarea[aria-label="Comment"]');
    if (!input) throw new Error('Missing comment editor');
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          [modifier]: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(linkEditRequested).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Comment"]',
      )?.value,
    ).toBe('Explain this');
  },
);

it('captures the quote when opening the menu rather than when choosing a destination', async () => {
  await render();
  await act(async () => commentButton().click());
  vi.spyOn(editor, 'getTextSelection').mockReturnValue(null);
  vi.spyOn(editor, 'getSelectionText').mockReturnValue('');
  vi.spyOn(editor, 'getSelectionClientRect').mockReturnValue(null);
  act(() => document.dispatchEvent(new Event('selectionchange')));
  writeComment();
  act(() => addButton().click());
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread')[0]?.quote,
  ).toBe('selected');
});

it('does not create a new conversation until a written comment is confirmed', async () => {
  await render();
  await act(async () => commentButton().click());
  act(() =>
    document
      .querySelector<HTMLButtonElement>('.ink-agent-destination-trigger')
      ?.click(),
  );
  const next = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.includes('Agent'));
  if (!next) throw new Error('Missing new Agent choice');
  act(() => next.click());
  expect(Object.keys(useChatStore.getState().threadsById)).toEqual(['thread']);
  expect(addButton().disabled).toBe(true);
  writeComment();
  expect(Object.keys(useChatStore.getState().threadsById)).toEqual(['thread']);
  act(() => addButton().click());
  const newThreads = Object.values(useChatStore.getState().threadsById).filter(
    (thread) => thread.pendingQuotedComments.length > 0,
  );
  expect(newThreads).toHaveLength(1);
  expect(newThreads[0]?.pendingQuotedComments[0]?.comment).toBe('Explain this');
  expect(newThreads[0]?.messages).toEqual([]);
});

it('leaves drafts untouched when cancelling after choosing a destination', async () => {
  await render();
  await act(async () => commentButton().click());
  writeComment();
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(document.querySelector('textarea[aria-label="Comment"]')).toBeNull();
  expect(selectThreadQuotedComments(useChatStore.getState(), 'thread')).toEqual(
    [],
  );
  expect(useChatStore.getState().threadsById.thread.draft).toBe(
    'Keep my instructions',
  );
});

it('keeps the original editing controls directly accessible without a conversation label', async () => {
  await render();
  expect(document.querySelector('button[aria-label="Bold"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="More"]')).toBeNull();
  expect(
    document.querySelector('button.selection-block-trigger'),
  ).not.toBeNull();
  expect(
    document.querySelector('button[aria-label="Text color"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('button[aria-label="Inline math"]'),
  ).not.toBeNull();
  expect(document.querySelector('.ink-agent-destination-trigger')).toBeNull();
  expect(document.querySelector('button[aria-label="Copy"]')).toBeNull();
  expect(document.querySelector('button[aria-label="Add as note"]')).toBeNull();
});
