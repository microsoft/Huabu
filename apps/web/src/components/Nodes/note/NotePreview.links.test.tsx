// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { MilkdownEditor } from '@/components/Milkdown/MilkdownEditor';
import { isElectron } from '@/hooks/useElectron';
import useCanvasStore from '@/store/canvasStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

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
});

it.each([true, false])(
  'routes Note links for Electron=%s and scopes the pointer cursor to its links',
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
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const initialWorkspace = usePreviewWorkspaceStore.getState().workspace;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Happy DOM cannot parse the full modern stylesheet. Exercise the actual
    // scoped rule against both real editor DOMs rather than duplicating its CSS.
    const overrides = readFileSync(
      'src/components/Milkdown/milkdown-overrides.css',
      'utf8',
    );
    const cursorRule = overrides.match(
      /\.milkdown-note-preview \.ProseMirror a\[href\]\s*\{[^}]*\}/,
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
          <MilkdownEditor markdown="[other](https://other.example)" />
        </>,
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container?.querySelectorAll('.ProseMirror a')).toHaveLength(2),
      );
    });
    const anchor = container?.querySelector<HTMLAnchorElement>(
      '.milkdown-note-preview .ProseMirror a',
    );
    const other = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.ProseMirror a') ?? [],
    ).find((candidate) => candidate !== anchor);
    if (!anchor || !other) throw new Error('Expected both editor links');
    expect(getComputedStyle(anchor).cursor).toBe('pointer');
    expect(getComputedStyle(other).cursor).not.toBe('pointer');
    act(() =>
      anchor.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      ),
    );
    const workspace = usePreviewWorkspaceStore.getState().workspace;
    if (inElectron) {
      expect(workspace.tabs[sourceId].transient).toBe(false);
      expect(
        Object.values(workspace.tabs).map((tab) => tab.target),
      ).toContainEqual({
        kind: 'url',
        canvasId,
        url: 'https://example.com/path',
      });
      expect(open).not.toHaveBeenCalled();
    } else {
      expect(workspace).toBe(initialWorkspace);
      expect(open).toHaveBeenCalledExactlyOnceWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer',
      );
    }
    open.mockClear();
    act(() =>
      other.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      ),
    );
    expect(usePreviewWorkspaceStore.getState().workspace).toBe(workspace);
    expect(open).not.toHaveBeenCalled();
  },
);
