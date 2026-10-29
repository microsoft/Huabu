// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getRecentCanvasConversation } from '@/api/canvas';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { copyToClipboard } from '@/utils/io/clipboard';

import { captureFileComment, FileCommentActions } from './FileCommentActions';

import type * as CanvasApi from '@/api/canvas';
import type { toast } from '@/components/Common/Toast';
import type { FileReadResult } from '@huabu/shared';

const notices = vi.hoisted(() => ({
  toast: vi.fn<typeof toast>(() => 'notice'),
  dismissToast: vi.fn(),
}));
vi.mock('@/components/Common/Toast', () => notices);
vi.mock('@/utils/io/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/canvas', async (original) => ({
  ...(await original<typeof CanvasApi>()),
  getRecentCanvasConversation: vi.fn(),
}));

const text = 'before 😀 selected passage after\nsecond line';
const file: FileReadResult = {
  path: '/canonical/source.tex',
  text,
  encoding: 'utf-8',
  contentVersion: 'a'.repeat(64),
  size: 400_000,
  byteLength: new TextEncoder().encode(text).length,
  nextCursor: 'more',
};
const identity = { canvasId: 'space', nodeId: 'file', agentletId: 'device' };
const originalAddNode = useCanvasStore.getState().addNode;
let host: HTMLDivElement;
let surface: HTMLDivElement;
let root: Root;
let view: EditorView;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  notices.toast.mockClear();
  notices.dismissToast.mockClear();
  vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
  vi.mocked(getRecentCanvasConversation).mockResolvedValue({
    conversation: null,
  });
  host = document.createElement('div');
  surface = document.createElement('div');
  document.body.append(host, surface);
  root = createRoot(host);
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: {
        anchor: text.indexOf('selected'),
        head: text.indexOf(' after'),
      },
      extensions: [
        EditorState.readOnly.of(true),
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
    parent: surface,
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({
    left: 20,
    right: 100,
    top: 20,
    bottom: 40,
  });
  vi.spyOn(view, 'requestMeasure').mockImplementation((request) => {
    if (request) request.write?.(request.read(view), view);
  });
  useCanvasStore.setState({
    addNode: originalAddNode,
    canvasId: 'space',
    pendingForkThreadIds: {},
    nodes: [
      {
        id: 'file',
        type: 'fileReference',
        position: { x: 0, y: 0 },
        data: {
          fileReference: { agentletId: 'device', path: file.path },
        },
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
  useChatStore.getState().setDraft('thread', 'Keep instructions');
  usePanelStore.setState({
    isRightCollapsed: false,
    focusChatInputRequest: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'space',
    workspace: createEmptyWorkspace('group'),
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  view.destroy();
  host.remove();
  surface.remove();
  act(() => useCanvasStore.setState({ canvasId: '', nodes: [] }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(value = file, disabled = false) {
  await act(async () =>
    root.render(
      <FileCommentActions
        {...identity}
        view={view}
        surfaceRef={{ current: surface }}
        file={value}
        disabled={disabled}
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
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

it('captures source-device identity, UTF-16 offsets and loaded-prefix context from the model', () => {
  const capture = captureFileComment(view, identity, file);
  expect(capture).toMatchObject({
    selection: {
      text: 'selected passage',
      contextBefore: 'before 😀 ',
      contextAfter: ' after\nsecond line',
    },
    source: {
      kind: 'file-reference',
      ...identity,
      path: file.path,
      contentVersion: file.contentVersion,
      from: 10,
      to: 26,
      offsetUnit: 'utf-16',
      loadedLength: text.length,
      complete: false,
    },
  });
  expect(capture?.source).not.toHaveProperty('snapshotRevision');
  expect(
    captureFileComment(view, identity, { ...file, nextCursor: undefined })
      ?.source,
  ).toMatchObject({ complete: true });
});

it('rejects empty, whitespace, disjoint or stale-document selections', () => {
  for (const selection of [
    EditorSelection.single(0),
    EditorSelection.single(6, 7),
    EditorSelection.create([
      EditorSelection.range(0, 3),
      EditorSelection.range(10, 15),
    ]),
  ]) {
    view.dispatch({ selection });
    expect(captureFileComment(view, identity, file)).toBeNull();
  }
  view.dispatch({ selection: { anchor: 10, head: 26 } });
  expect(
    captureFileComment(view, identity, { ...file, text: 'replacement' }),
  ).toBeNull();
});

it('bounds context to loaded text and 40 UTF-16 positions without depending on rendered lines', () => {
  const long = `${'a'.repeat(200)}excerpt${'b'.repeat(200)}`;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: long },
    selection: { anchor: 200, head: 207 },
  });
  const capture = captureFileComment(view, identity, { ...file, text: long });
  expect(capture?.selection.contextBefore).toBe('a'.repeat(40));
  expect(capture?.selection.contextAfter).toBe('b'.repeat(40));
  expect(capture?.selection.text).toBe('excerpt');
});

it('keeps an opened snapshot frozen across refresh/error and stages without navigation, creation or send', async () => {
  await render();
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  await act(async () => button('Comment').click());
  expect(document.body.textContent).toContain(file.path);
  expect(document.body.textContent).toContain('Captured file snapshot');
  const input = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Comment"]',
  );
  if (!input) throw new Error('Missing Comment input');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Missing textarea setter');
  await act(async () => {
    setter.call(input, 'Explain this file');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await render(
    { ...file, text: 'replacement', contentVersion: 'b'.repeat(64) },
    true,
  );
  await act(async () => {
    button('Add to input').click();
  });
  expect(useChatStore.getState().threadsById.thread.draft).toBe(
    'Keep instructions',
  );
  const [quote] =
    useChatStore.getState().threadsById.thread.pendingQuotedComments;
  expect(quote).toMatchObject({
    quote: 'selected passage',
    comment: 'Explain this file',
    source: {
      contentVersion: file.contentVersion,
      path: file.path,
      agentletId: 'device',
    },
  });
  expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
  expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  expect(notices.toast).toHaveBeenCalledOnce();
  expect(view.state.readOnly).toBe(true);
});

it('does not offer new captures while loading or showing a read failure', async () => {
  await render(file, true);
  expect(document.querySelector('button[aria-label="Comment"]')).toBeNull();
  await render(file, false);
  expect(button('Comment')).toBeDefined();
  expect(document.body.textContent).not.toContain('New Agent');
});

it('reuses Chat action order and copies only the current selected text', async () => {
  await render();
  expect(
    [...document.querySelectorAll('button')].map((item) =>
      item.getAttribute('aria-label'),
    ),
  ).toEqual(['Copy', 'Add as note', 'Comment']);
  await act(async () => button('Copy').click());
  expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith('selected passage');
  expect(view.state.selection.main.empty).toBe(true);
  expect(document.querySelector('button[aria-label="Copy"]')).toBeNull();
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  expect(useChatStore.getState().threadsById.thread.draft).toBe(
    'Keep instructions',
  );
});

it('keeps selection and reports clipboard failures for retry', async () => {
  vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error('Denied'));
  await render();
  await act(async () => button('Copy').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not copy',
  );
  expect(view.state.selection.main.empty).toBe(false);
  expect(button('Copy').disabled).toBe(false);
  await act(async () => button('Copy').click());
  expect(copyToClipboard).toHaveBeenCalledTimes(2);
  expect(view.state.selection.main.empty).toBe(true);
});

it('saves only selected source text as a Note with reference provenance', async () => {
  const addNode = vi
    .spyOn(useCanvasStore.getState(), 'addNode')
    .mockImplementation(() => {});
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  await render();
  await act(async () => button('Add as note').click());
  expect(addNode).toHaveBeenCalledExactlyOnceWith({
    nodeType: 'note',
    data: {
      content: 'selected passage',
      origin: { type: 'user-excerpt', excerptFromNodeId: 'file' },
    },
  });
  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe(file.text);
  expect(view.state.readOnly).toBe(true);
  expect(view.state.selection.main.empty).toBe(true);
  expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
  expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
  expect(
    useChatStore.getState().threadsById.thread.pendingQuotedComments,
  ).toEqual([]);
});

it('rejects actions whose model selection expired after the toolbar appeared', async () => {
  const addNode = vi
    .spyOn(useCanvasStore.getState(), 'addNode')
    .mockImplementation(() => {});
  await render();
  vi.spyOn(view, 'coordsAtPos').mockReturnValue(null);
  await act(async () => button('Add as note').click());
  expect(addNode).not.toHaveBeenCalled();
  expect(notices.toast).toHaveBeenCalledWith(expect.any(String), {
    tone: 'warning',
  });
});

it('preserves selected line breaks when saving a multiline source excerpt', async () => {
  const addNode = vi
    .spyOn(useCanvasStore.getState(), 'addNode')
    .mockImplementation(() => {});
  view.dispatch({ selection: { anchor: 10, head: text.length } });
  await render();
  await act(async () => button('Add as note').click());
  expect(addNode).toHaveBeenCalledExactlyOnceWith({
    nodeType: 'note',
    data: {
      content: 'selected passage after\nsecond line',
      origin: { type: 'user-excerpt', excerptFromNodeId: 'file' },
    },
  });
});
