// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { MilkdownMessageCard } from '@/components/Messages/AIMessage/MilkdownMessageCard';
import { MilkdownEditor } from '@/components/Milkdown/MilkdownEditor';
import { MilkdownPreview } from '@/components/Milkdown/MilkdownPreview';
import { isElectron } from '@/hooks/useElectron';
import useCanvasStore from '@/store/canvasStore';
import {
  createEmptyWorkspace,
  groupOfTab,
} from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { isMac } from '@/utils/platform';

import { NotePreview } from './NotePreview';

vi.mock('@/hooks/useElectron', () => ({ isElectron: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  useCanvasStore.setState({ canvasId: '', nodes: [] });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace('group'),
  });
});

it.each([true, false])(
  'shares Note and Chat cursor/routing policy for Electron=%s without enabling canvas navigation',
  async (inElectron) => {
    vi.mocked(isElectron).mockReturnValue(inElectron);
    const canvasId = 'note-links-canvas';
    useCanvasStore.setState({ canvasId, nodes: [] });
    usePreviewWorkspaceStore.setState({
      canvasId,
      workspace: createEmptyWorkspace('group'),
    });
    const sourceId = usePreviewWorkspaceStore
      .getState()
      .openPreviewTarget(
        { kind: 'node', canvasId, nodeId: 'note' },
        { transient: true },
      );
    const chatSourceId = usePreviewWorkspaceStore
      .getState()
      .openPreviewTarget(
        { kind: 'chat', canvasId, threadId: 'chat-thread' },
        { transient: true, openToSide: true },
      );
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const initialWorkspace = usePreviewWorkspaceStore.getState().workspace;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Happy DOM cannot parse the full modern stylesheet. Exercise the actual
    // scoped rule against real Note, Chat, and canvas editor DOMs.
    const overrides = readFileSync(
      'src/components/Milkdown/milkdown-overrides.css',
      'utf8',
    );
    const cursorRule = overrides.match(
      /\.milkdown \.ProseMirror\[data-link-activation=['"]plain['"]\] a\[href\]\s*\{[^}]*\}/,
    )?.[0];
    expect(cursorRule).toBeDefined();
    act(() =>
      root?.render(
        <>
          <style>{cursorRule}</style>
          <NotePreview
            id="note"
            readOnly
            data={{ content: '[docs](https://example.com/path)' }}
          />
          <div data-testid="chat">
            <MilkdownMessageCard
              content="[chat docs](https://chat.example/path)"
              threadId="chat-thread"
            />
          </div>
          <div data-testid="canvas-note">
            <MilkdownPreview
              markdown="[canvas](https://canvas.example)"
              linkActivation="modifier"
            />
          </div>
          <div data-testid="editor">
            <MilkdownEditor markdown="[other](https://other.example)" />
          </div>
        </>,
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container?.querySelectorAll('.ProseMirror a')).toHaveLength(4),
      );
    });
    const anchor = container?.querySelector<HTMLAnchorElement>(
      '.milkdown-note-preview .ProseMirror a',
    );
    const chat = container?.querySelector<HTMLAnchorElement>(
      '[data-testid="chat"] a[href]',
    );
    const canvas = container?.querySelector<HTMLAnchorElement>(
      '[data-testid="canvas-note"] a[href]',
    );
    const other = container?.querySelector<HTMLAnchorElement>(
      '[data-testid="editor"] a[href]',
    );
    if (!anchor || !chat || !canvas || !other)
      throw new Error('Expected all four editor links');

    for (const [link, tabId] of [
      [anchor, sourceId],
      [chat, chatSourceId],
    ] as const) {
      expect(
        link.closest('.ProseMirror')?.getAttribute('data-link-activation'),
      ).toBe('plain');
      expect(getComputedStyle(link).cursor).toBe('pointer');
      // The other group is focused: routing must use the actual document source.
      const sourceGroup = groupOfTab(initialWorkspace, tabId)?.id;
      if (inElectron) {
        const otherGroup = initialWorkspace.groups.find(
          (group) => group.id !== sourceGroup,
        );
        if (!otherGroup) throw new Error('Expected a split workspace');
        act(() =>
          usePreviewWorkspaceStore.getState().setActiveGroup(otherGroup.id),
        );
      }
      open.mockClear();
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
      });
      act(() => link.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      const workspace = usePreviewWorkspaceStore.getState().workspace;
      if (inElectron) {
        expect(workspace.tabs[tabId].transient).toBe(false);
        const urlTab = Object.values(workspace.tabs).find(
          (tab) => tab.target.kind === 'url' && tab.target.url === link.href,
        );
        if (!urlTab) throw new Error('Expected a URL preview tab');
        expect(urlTab.target).toEqual({
          kind: 'url',
          canvasId,
          url: link.href,
        });
        expect(urlTab.transient).toBe(false);
        expect(groupOfTab(workspace, urlTab.id)?.id).toBe(sourceGroup);
        expect(open).not.toHaveBeenCalled();
      } else {
        expect(workspace).toBe(initialWorkspace);
        expect(open).toHaveBeenCalledExactlyOnceWith(
          link.href,
          '_blank',
          'noopener,noreferrer',
        );
      }

      open.mockClear();
      act(() =>
        link.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 1,
            ...(isMac ? { metaKey: true } : { ctrlKey: true }),
          }),
        ),
      );
      expect(open).toHaveBeenCalledExactlyOnceWith(
        link.href,
        '_blank',
        'noopener,noreferrer',
      );
      expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
    }

    const workspace = usePreviewWorkspaceStore.getState().workspace;
    for (const link of [canvas, other]) {
      expect(
        link.closest('.ProseMirror')?.getAttribute('data-link-activation'),
      ).toBe('modifier');
      expect(getComputedStyle(link).cursor).not.toBe('pointer');
      open.mockClear();
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
      });
      act(() => link.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
      expect(open).not.toHaveBeenCalled();
    }
  },
);
