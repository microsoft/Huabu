// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMac } from '@/utils/platform';

import { useGlobalSearchHotkey } from './useGlobalSearchHotkey';
import useCanvasStore from '../store/canvasStore';
import { usePanelStore } from '../store/panelStore';
import { usePreviewSearchStore } from '../store/previewSearchStore';
import { useSearchStore } from '../store/searchStore';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

function SearchHotkeyProbe({
  scope,
}: {
  scope: 'canvas' | 'node';
}): React.JSX.Element {
  useGlobalSearchHotkey();
  return (
    <div
      data-search-scope={scope}
      data-search-node-id={scope === 'node' ? 'pdf-1' : undefined}
      tabIndex={-1}
    />
  );
}

function pressFind(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCanvasStore.setState({ canvasId: 'canvas-1' });
  usePanelStore.setState({ isLeftCollapsed: true, isSearchOpen: false });
  usePreviewSearchStore.getState().close();
  useSearchStore.getState().close();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useGlobalSearchHotkey search layers', () => {
  it('opens preview search without touching Canvas search or its panel', () => {
    act(() => root.render(<SearchHotkeyProbe scope="node" />));
    const target = container.querySelector<HTMLElement>('[data-search-scope]');
    target?.focus();

    act(() => pressFind());

    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'pdf-1',
      isOpen: true,
    });
    expect(useSearchStore.getState().scope).toBeNull();
    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: true,
      isSearchOpen: false,
    });
  });

  it('opens Canvas search without changing preview search', () => {
    usePreviewSearchStore.getState().open('pdf-1');
    usePreviewSearchStore.getState().setQuery('pdf query');
    act(() => root.render(<SearchHotkeyProbe scope="canvas" />));
    const target = container.querySelector<HTMLElement>('[data-search-scope]');
    target?.focus();

    act(() => pressFind());

    expect(useSearchStore.getState().scope).toEqual({
      kind: 'canvas',
      canvasId: 'canvas-1',
    });
    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: false,
      isSearchOpen: true,
    });
    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'pdf-1',
      query: 'pdf query',
      isOpen: true,
    });
  });
});
