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
import type { toast } from '@/components/Common/Toast';

const notices = vi.hoisted(() => ({
  toast: vi.fn<typeof toast>(() => 'notice'),
  dismissToast: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => notices);
vi.mock('@/api/canvas', async (original) => ({
  ...(await original<typeof CanvasApi>()),
  getRecentCanvasConversation: vi.fn(),
}));

let editor: MilkdownInstance;
let editorRoot: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  notices.toast.mockClear();
  notices.dismissToast.mockClear();
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
        selected: true,
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
  act(() => useCanvasStore.setState({ canvasId: '', nodes: [] }));
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
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function begin() {
  await act(async () => button('Comment').click());
  const input = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Comment"]',
  );
  if (!input) throw new Error('Missing Comment input');
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(input, 'Explain this');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each(['edit', 'selection'] as const)(
  'freezes Note evidence and stages into a busy existing conversation in %s mode without navigation',
  async (mode) => {
    await render(mode);
    const revision = nodeRevisionOf({ content: editor.getMarkdown() });
    const workspace = usePreviewWorkspaceStore.getState().workspace;
    const nodes = useCanvasStore.getState().nodes;
    await begin();
    act(() => editor.setMarkdown('Changed after capture'));
    act(() => button('Add to input').click());
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'thread'),
    ).toMatchObject([
      {
        quote: 'selected',
        contextBefore: 'Before ',
        contextAfter: ' after. Second paragraph.',
        comment: 'Explain this',
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
    expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
    expect(notices.toast).toHaveBeenCalledWith(
      'Comment added to Reader input.',
      expect.objectContaining({
        duration: 0,
        action: expect.objectContaining({ label: 'View input' }),
      }),
    );
  },
);

it('offers no New action when there are no existing conversations', async () => {
  useCanvasStore.setState({ nodes: [] });
  await render();
  await begin();
  expect(button('Add to input').disabled).toBe(true);
  act(() => button('Choose an existing conversation').click());
  expect(document.body.textContent).toContain(
    'Create a conversation separately',
  );
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
});

it('disables staging after a destination is rebound and preserves the comment for reselection', async () => {
  await render();
  await begin();
  act(() =>
    useCanvasStore.setState({
      nodes: [
        {
          id: 'agent',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { threadId: 'replacement', label: 'Reader' },
        },
      ],
    }),
  );
  expect(button('Add to input').disabled).toBe(true);
  expect(document.querySelector('textarea')?.value).toBe('Explain this');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'unavailable',
  );
  expect(selectThreadQuotedComments(useChatStore.getState(), 'thread')).toEqual(
    [],
  );
});

it('focuses an already visible destination without altering tabs', async () => {
  usePreviewWorkspaceStore
    .getState()
    .openPreviewTarget(
      { kind: 'node', canvasId: 'space', nodeId: 'agent' },
      { openToSide: true },
    );
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  await render();
  await begin();
  act(() => button('Add to input').click());
  expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
  expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
    'thread',
  );
  expect(notices.toast).not.toHaveBeenCalled();
});

it('only opens a hidden destination after explicit notification activation and retires consumed notices', async () => {
  await render();
  await begin();
  act(() => button('Add to input').click());
  const action = notices.toast.mock.calls[0]?.[1]?.action;
  if (!action) throw new Error('Missing notification action');
  act(() => action.onClick());
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  expect(
    Object.values(workspace.tabs).some(
      (tab) => tab.target.kind === 'node' && tab.target.nodeId === 'agent',
    ),
  ).toBe(true);
  expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
    'thread',
  );
  expect(notices.dismissToast).toHaveBeenCalledWith('notice');
});

it('dismisses the pending notification when its draft is removed', async () => {
  await render();
  await begin();
  act(() => button('Add to input').click());
  notices.dismissToast.mockClear();
  act(() => useChatStore.getState().removeQuotedComment('thread', 0));
  expect(notices.dismissToast).toHaveBeenCalledWith('notice');
});

it('reports a selection that disappears before action activation without staging', async () => {
  await render();
  const action = button('Comment');
  vi.spyOn(editor, 'getTextSelection').mockReturnValue(null);
  act(() => action.click());
  expect(notices.toast).toHaveBeenCalledWith(
    expect.stringContaining('Select the passage again'),
    { tone: 'warning' },
  );
  expect(selectThreadQuotedComments(useChatStore.getState(), 'thread')).toEqual(
    [],
  );
});

it('coalesces repeated staging and cannot navigate after the owner or Space changes', async () => {
  await render();
  await begin();
  act(() => button('Add to input').click());
  await begin();
  act(() => button('Add to input').click());
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toHaveLength(2);
  expect(notices.dismissToast).toHaveBeenCalledWith('notice');
  const action = notices.toast.mock.calls.at(-1)?.[1]?.action;
  if (!action) throw new Error('Missing notification action');
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  act(() => useCanvasStore.setState({ canvasId: 'other' }));
  act(() => action.onClick());
  expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
  expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
  expect(notices.toast).toHaveBeenLastCalledWith(
    expect.stringContaining('unavailable'),
    { tone: 'warning' },
  );
});
