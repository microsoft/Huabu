// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasSearchInput } from './CanvasSearchInput';
import { useGlobalSearchHotkey } from '../../../hooks/useGlobalSearchHotkey';
import useCanvasStore from '../../../store/canvasStore';
import { usePanelStore } from '../../../store/panelStore';
import { usePreviewSearchStore } from '../../../store/previewSearchStore';
import { useSearchStore } from '../../../store/searchStore';
import { isMac } from '../../../utils/platform';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('lottie-react', () => ({ default: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function SearchHarness({ previewFullscreen = false } = {}) {
  useGlobalSearchHotkey();
  const isCollapsed = usePanelStore((s) => s.isLeftCollapsed);
  return (
    <>
      <div inert={isCollapsed}>
        <CanvasSearchInput />
      </div>
      {previewFullscreen ? (
        <div data-canvas-panel="right" tabIndex={-1} />
      ) : (
        <div data-canvas-root data-search-scope="canvas" tabIndex={-1} />
      )}
    </>
  );
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(
    '[data-canvas-search-input]',
  );
  if (!element) throw new Error('Missing Canvas search field');
  return element;
}

function canvas(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>('[data-canvas-root]');
  if (!element) throw new Error('Missing Canvas focus target');
  return element;
}

function pressFind() {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    bubbles: true,
    cancelable: true,
    ...(isMac ? { metaKey: true } : { ctrlKey: true }),
  });
  act(() => window.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCanvasStore.setState({ canvasId: 'canvas-1' });
  usePanelStore.setState({
    isLeftCollapsed: false,
    focusCanvasSearchRequest: null,
  });
  useSearchStore.getState().close();
  usePreviewSearchStore.getState().close();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSearchStore.getState().close();
  usePreviewSearchStore.getState().close();
});

describe('permanent Canvas search', () => {
  it('mounts without stealing focus or opening a search scope', () => {
    container.tabIndex = -1;
    container.focus();
    act(() => root.render(<SearchHarness />));

    expect(input()).toBeDefined();
    expect(document.activeElement).toBe(container);
    expect(useSearchStore.getState().scope).toBeNull();
  });

  it('keeps the Find hint platform-aware with a local gap between macOS key tokens', () => {
    act(() => root.render(<SearchHarness />));
    const hint = container.querySelector('kbd');
    if (!hint) throw new Error('Missing Find shortcut hint');
    expect(hint.textContent).toBe(isMac ? '⌘F' : 'Ctrl+F');
    expect(hint.classList.contains('gap-0.5')).toBe(true);
    expect(hint.querySelectorAll('span')).toHaveLength(isMac ? 2 : 0);
  });

  it('does not steal focus on manual panel expansion', () => {
    usePanelStore.setState({ isLeftCollapsed: true });
    act(() => root.render(<SearchHarness />));
    canvas().focus();

    act(() => usePanelStore.getState().setLeftCollapsed(false));

    expect(document.activeElement).toBe(canvas());
    expect(usePanelStore.getState().focusCanvasSearchRequest).toBeNull();
  });

  it('expands a collapsed panel and consumes an explicit Find request', () => {
    usePanelStore.setState({ isLeftCollapsed: true });
    act(() => root.render(<SearchHarness />));
    canvas().focus();

    pressFind();

    expect(usePanelStore.getState().isLeftCollapsed).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(input().closest('[inert]')).toBeNull();
    expect(usePanelStore.getState().focusCanvasSearchRequest).toBeNull();
    expect(useSearchStore.getState().scope).toEqual({
      kind: 'canvas',
      canvasId: 'canvas-1',
    });
  });

  it('repeated Find selects the current query without clearing it', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));
    canvas().focus();

    pressFind();

    expect(document.activeElement).toBe(input());
    expect(input().value).toBe('example');
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 7]);
  });

  it('keeps Find in Canvas scope when a Preview is mounted', () => {
    act(() => root.render(<SearchHarness />));
    const preview = document.createElement('div');
    preview.dataset.searchScope = 'node';
    preview.dataset.searchNodeId = 'pdf-1';
    container.appendChild(preview);
    input().focus();

    pressFind();

    expect(document.activeElement).toBe(input());
    expect(usePreviewSearchStore.getState().isOpen).toBe(false);
    expect(useSearchStore.getState().scope?.canvasId).toBe('canvas-1');
  });

  it('Escape clears search and returns focus without unmounting the input', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));
    const field = input();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    act(() => field.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(input()).toBe(field);
    expect(field.value).toBe('');
    expect(useSearchStore.getState().scope).toBeNull();
    expect(document.activeElement).toBe(canvas());
    expect(usePanelStore.getState().isLeftCollapsed).toBe(false);
  });

  it('the clear button retains input focus', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));
    const clear = container.querySelector<HTMLButtonElement>(
      '[aria-label^="search.clear"]',
    );
    if (!clear) throw new Error('Missing search clear action');

    act(() => clear.click());

    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('Escape focuses Preview when fullscreen has unmounted Canvas', () => {
    act(() => root.render(<SearchHarness previewFullscreen />));
    input().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));

    act(() =>
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );

    expect(input().value).toBe('');
    expect(document.activeElement).toBe(
      container.querySelector('[data-canvas-panel="right"]'),
    );
  });

  it('preserves the query on collapse and does not refocus on reopening', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));
    canvas().focus();

    act(() => usePanelStore.getState().setLeftCollapsed(true));
    act(() => usePanelStore.getState().setLeftCollapsed(false));

    expect(input().value).toBe('example');
    expect(document.activeElement).toBe(canvas());
  });

  it('clears stale search when switching Spaces without stealing focus', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => useSearchStore.getState().setQuery('example'));
    canvas().focus();

    act(() => useCanvasStore.setState({ canvasId: 'canvas-2' }));

    expect(input().value).toBe('');
    expect(useSearchStore.getState().scope).toBeNull();
    expect(document.activeElement).toBe(canvas());
  });

  it('does not replay a consumed focus request on field remount', () => {
    act(() => root.render(<SearchHarness />));
    canvas().focus();
    pressFind();
    act(() => root.render(null));
    container.tabIndex = -1;
    container.focus();

    act(() => root.render(<SearchHarness />));

    expect(document.activeElement).toBe(container);
    expect(useSearchStore.getState().scope).toBeNull();
  });
});
