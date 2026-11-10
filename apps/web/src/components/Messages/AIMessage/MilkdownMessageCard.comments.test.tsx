// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { selectThreadQuotedComments, useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { copyToClipboard } from '@/utils/io/clipboard';

import { MilkdownMessageCard } from './MilkdownMessageCard';

import type { MilkdownPreviewSelection } from '@/components/Milkdown/MilkdownPreview';

const preview = vi.hoisted(() => ({
  select: undefined as
    | ((selection: MilkdownPreviewSelection | null) => void)
    | undefined,
}));
vi.mock('@/components/Milkdown', () => ({
  MilkdownPreview: ({
    onTextSelection,
  }: {
    onTextSelection?: typeof preview.select;
  }) => {
    preview.select = onTextSelection;
    return <div>Answer</div>;
  },
}));
vi.mock('@/utils/io/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/useAcpProfiles', () => ({
  useAcpProfiles: () => ({
    profiles: [],
    loaded: true,
    error: null,
    refresh: vi.fn(),
  }),
}));

const selection: MilkdownPreviewSelection = {
  range: { from: 1, to: 8 },
  text: 'selected passage',
  markdown: '**selected** passage',
  contextBefore: 'Before ',
  contextAfter: ' after',
  position: { x: 20, y: 20 },
};
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  useCanvasStore.setState({
    canvasId: 'space',
    nodes: [],
    pendingForkThreadIds: {},
  });
  useChatStore.setState({ threadsById: {} });
  useAcpProfilesStore.setState({ loaded: true, profiles: [] });
  usePanelStore.setState({ focusChatInputRequest: null });
  usePreviewWorkspaceStore.setState({
    canvasId: 'space',
    workspace: createEmptyWorkspace('group'),
  });
  vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(enabled = true, remote = false) {
  await act(async () =>
    root.render(
      <MilkdownMessageCard
        content="Answer"
        threadId="thread"
        messageId="message"
        enableComments={enabled}
        sourceCanvasId={remote ? 'remote' : undefined}
        canvasActionsDisabled={remote}
      />,
    ),
  );
  await act(async () => preview.select?.(selection));
}
function button(name: string) {
  const result = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
function confirmComment() {
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
  act(() => button('Add to input').click());
}

it('stages one captured quote directly into the current draft without sending', async () => {
  useChatStore.getState().setDraft('thread', 'Keep my draft');
  await render();
  expect(document.querySelectorAll('.canvas-context-toolbar')).toHaveLength(2);
  expect(document.querySelector('.ink-agent-destination-trigger')).toBeNull();
  expect(document.querySelector('textarea')).toBeNull();
  act(() => button('Comment on selection').click());
  expect(button('Add to input').disabled).toBe(true);
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toHaveLength(0);
  confirmComment();
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toMatchObject([
    {
      quote: 'selected passage',
      comment: 'Explain this',
      contextBefore: 'Before ',
      contextAfter: ' after',
      source: {
        kind: 'chat',
        canvasId: 'space',
        threadId: 'thread',
        messageId: 'message',
      },
    },
  ]);
  expect(useChatStore.getState().threadsById.thread.draft).toBe(
    'Keep my draft',
  );
  expect(useChatStore.getState().threadsById.thread.messages).toEqual([]);
  expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
    'thread',
  );
});

it('copies plain selection and exposes clipboard failure for retry', async () => {
  vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error('denied'));
  await render();
  await act(async () => button('Copy').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not copy',
  );
  await act(async () => button('Copy').click());
  expect(copyToClipboard).toHaveBeenLastCalledWith('selected passage');
  expect(
    document.querySelector('[aria-label="Comment on selection"]'),
  ).toBeNull();
});

it('saves Markdown with the original Chat thread attribution', async () => {
  const add = vi
    .spyOn(useCanvasStore.getState(), 'addNode')
    .mockReturnValue(undefined);
  await render();
  act(() => button('Add as note').click());
  expect(add).toHaveBeenCalledWith({
    nodeType: 'note',
    data: {
      content: '**selected** passage',
      origin: { type: 'user-from-chat', threadId: 'thread' },
    },
  });
});

it('keeps remote Chat quotes attributed and Canvas-only actions disabled', async () => {
  await render(true, true);
  expect(button('Add as note').disabled).toBe(true);
  act(() => button('Comment on selection').click());
  confirmComment();
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread')[0]?.source,
  ).toMatchObject({
    kind: 'chat',
    canvasId: 'remote',
    threadId: 'thread',
  });
});

it('does not offer selection actions when comments are disabled', async () => {
  await render(false);
  expect(preview.select).toBeUndefined();
  expect(document.querySelector('.canvas-context-toolbar')).toBeNull();
});

it('keeps quotes in their source Chat even when other conversations exist', async () => {
  useCanvasStore.setState({
    nodes: [
      {
        id: 'other-agent',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { label: 'Other conversation', threadId: 'other-thread' },
      },
    ],
  });
  await render();
  expect(document.querySelector('[aria-haspopup="menu"]')).toBeNull();
  act(() => button('Comment on selection').click());
  expect(document.querySelector('.ink-agent-destination-trigger')).toBeNull();
  confirmComment();
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toHaveLength(1);
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'other-thread'),
  ).toHaveLength(0);
  expect(usePreviewWorkspaceStore.getState().workspace.groups).toHaveLength(1);
});

it('does not stage a quote into a pending fork', async () => {
  await render();
  useCanvasStore.setState({ pendingForkThreadIds: { thread: true } });
  act(() => button('Comment on selection').click());
  confirmComment();
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toHaveLength(0);
  expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
});

it('cancels an unwritten comment without changing the draft', async () => {
  useChatStore.getState().setDraft('thread', 'Keep this');
  await render();
  act(() => button('Comment on selection').click());
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread'),
  ).toHaveLength(0);
  expect(useChatStore.getState().threadsById.thread.draft).toBe('Keep this');
  act(() => preview.select?.({ ...selection, text: 'another passage' }));
  act(() => button('Comment on selection').click());
  confirmComment();
  expect(
    selectThreadQuotedComments(useChatStore.getState(), 'thread')[0]?.quote,
  ).toBe('another passage');
});
