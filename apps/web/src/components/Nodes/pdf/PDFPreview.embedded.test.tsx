// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode, type KeyboardEventHandler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PDFPreview } from './PDFPreview';

interface DocumentProps {
  children: ReactNode;
  error: ReactNode;
  onLoadError: () => void;
  onLoadSuccess: (document: { numPages: number }) => void;
}

const mocks = vi.hoisted(() => ({
  registerSearch: vi.fn(),
  index: vi.fn(),
  document: vi.fn<(props: DocumentProps) => void>(),
  page: vi.fn(),
  header: null as HTMLElement | null,
  intersection: null as IntersectionObserverCallback | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: (src: string) => src,
  uploadImage: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (state: unknown) => unknown) =>
    select({ canvasId: 'canvas-1' }),
}));
vi.mock('@/store/chatStore', () => ({ useChatStore: {} }));
vi.mock('@/store/conversationOwner', () => ({
  conversationViewForNode: vi.fn(),
}));
vi.mock('@/store/panelStore', () => ({ usePanelStore: {} }));
vi.mock('@/store/previewWorkspace/store', () => ({
  usePreviewWorkspaceStore: {},
}));
vi.mock('@/store/previewSearchStore', () => ({
  usePreviewSearchStore: (select: (state: unknown) => unknown) =>
    select({ nodeId: 'pdf-1', query: 'existing search', isOpen: true }),
}));
vi.mock('@/components/Nodes/PreviewHeaderSlot', () => ({
  usePreviewHeaderSlot: () => ({ el: mocks.header }),
}));
vi.mock(
  '@/components/Panels/ExpandedNodePanel/PreviewSearchAdapterContext',
  () => ({
    useRegisterPreviewSearchAdapter: mocks.registerSearch,
  }),
);
vi.mock('./usePdfTextIndex', () => ({
  usePdfTextIndex: (options: unknown) => {
    mocks.index(options);
    return { pages: new Map(), isIndexing: false };
  },
}));
vi.mock('./pdfWorker', () => ({ PDF_DOCUMENT_OPTIONS: {} }));
vi.mock('../FloatingDragHandle', () => ({
  FloatingDragHandle: () => <div data-drag-handle />,
}));
vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <div data-loading />,
}));
vi.mock('@/components/Common/Button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock('react-pdf', () => ({
  Document: (props: DocumentProps) => {
    mocks.document(props);
    return (
      <>
        {props.children}
        {props.error}
      </>
    );
  },
}));
vi.mock('./PDFPageWithOverlay', () => ({
  PDFPageWithOverlay: (props: {
    pageIndex: number;
    captureEnabled: boolean;
  }) => {
    mocks.page(props);
    return <div data-page={props.pageIndex} />;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.intersection = null;
  mocks.header = document.createElement('div');
  document.body.append(mocks.header);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        mocks.intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocks.header?.remove();
  vi.unstubAllGlobals();
});

function render(
  interactive = false,
  embedded = true,
  onDoubleClick?: () => void,
  onKeyDown?: KeyboardEventHandler,
) {
  act(() =>
    root.render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Simulates the enclosing React Flow event boundary, not an interactive control.
      <div onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>
        <PDFPreview
          id="pdf-1"
          data={{ src: 'document.pdf' }}
          embedded={embedded}
          interactive={interactive}
        />
      </div>,
    ),
  );
}

function load() {
  act(() => mocks.document.mock.lastCall?.[0].onLoadSuccess({ numPages: 20 }));
}

describe('embedded PDF reader', () => {
  it.each([true, false])(
    'claims navigation keys only while embedded reader is interactive: %s',
    (interactive) => {
      const ancestor = vi.fn();
      render(interactive, true, undefined, ancestor);
      const viewport = container.querySelector('[data-pdf-scroll-viewport]');
      if (!viewport) throw new Error('Missing viewport');
      expect(
        container.querySelector('[data-keyboard-interactive]') !== null,
      ).toBe(interactive);
      for (const key of [
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        ' ',
      ]) {
        ancestor.mockClear();
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        });
        act(() => viewport.dispatchEvent(event));
        expect(ancestor).toHaveBeenCalledTimes(interactive ? 0 : 1);
        expect(event.defaultPrevented).toBe(false);
      }
      for (const key of ['Escape', 'Tab', 'Enter', 'PageDown', 'Home']) {
        ancestor.mockClear();
        act(() =>
          viewport.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          ),
        );
        expect(ancestor).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    [true, true, 0],
    [false, true, 1],
    [true, false, 1],
  ])(
    'contains double-click only for interactive embedded content (%s, %s)',
    (interactive, embedded, calls) => {
      const onDoubleClick = vi.fn();
      render(interactive, embedded, onDoubleClick);
      load();
      const page = container.querySelector('[data-page]');
      if (!page) throw new Error('Missing PDF page');
      const event = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
      });
      act(() => page.dispatchEvent(event));
      expect(onDoubleClick).toHaveBeenCalledTimes(calls);
      // Native word selection must not be cancelled.
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it('reuses virtualized pages without preview tools, search indexing, or header portals', () => {
    render();
    load();
    expect(container.querySelectorAll('[data-pdf-page-shell]')).toHaveLength(
      20,
    );
    expect(container.querySelectorAll('[data-page]')).toHaveLength(1);
    expect(mocks.page).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureEnabled: false }),
    );
    expect(mocks.header?.childElementCount).toBe(0);
    expect(mocks.registerSearch).not.toHaveBeenCalled();
    expect(mocks.index).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(
      container.querySelector('[data-pdf-reader]')?.hasAttribute('inert'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-pdf-scroll-viewport]')
        ?.classList.contains('overflow-y-hidden'),
    ).toBe(true);

    const page = container.querySelector('[data-pdf-page-shell="10"]');
    act(() =>
      mocks.intersection?.(
        [{ target: page, isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(container.querySelector('[data-page="10"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-page]')).toHaveLength(2);
  });

  it('contains sole-selected regular wheel at either edge but passes modifier gestures to canvas', () => {
    const canvasWheel = vi.fn();
    container.addEventListener('wheel', canvasWheel);
    render(true);
    const viewport = container.querySelector<HTMLElement>(
      '[data-pdf-scroll-viewport]',
    );
    if (!viewport) throw new Error('Missing PDF scroll viewport');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 600 },
    });
    expect(
      container.querySelector('[data-pdf-reader]')?.hasAttribute('inert'),
    ).toBe(false);
    expect(viewport.tabIndex).toBe(0);
    for (const scrollTop of [0, 1400]) {
      viewport.scrollTop = scrollTop;
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 20,
      });
      viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(canvasWheel).not.toHaveBeenCalled();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      const event = new WheelEvent('wheel', { bubbles: true });
      // Happy DOM does not initialize inherited WheelEvent modifiers.
      Object.defineProperty(event, modifier, { value: true });
      viewport.dispatchEvent(event);
    }
    expect(canvasWheel).toHaveBeenCalledTimes(4);

    render(false);
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(canvasWheel).toHaveBeenCalledTimes(5);
    expect(viewport.classList.contains('overflow-y-hidden')).toBe(true);
    container.removeEventListener('wheel', canvasWheel);
  });

  it('keeps loading failures visible and permits an explicit retry', () => {
    render(true);
    expect(container.querySelector('[data-loading]')).not.toBeNull();
    act(() => mocks.document.mock.lastCall?.[0].onLoadError());
    expect(container.querySelector('[data-loading]')).toBeNull();
    expect(container.textContent).toContain('node.errorLoadingPdf');
    act(() => container.querySelector('button')?.click());
    expect(container.querySelector('[data-loading]')).not.toBeNull();
    load();
    expect(container.querySelector('[data-loading]')).toBeNull();
  });

  it('preserves header actions and search integration for expanded previews', () => {
    render(true, false);
    load();
    expect(mocks.header?.querySelectorAll('button')).toHaveLength(2);
    expect(mocks.registerSearch).toHaveBeenCalled();
    expect(mocks.index).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(
      container
        .querySelector('[data-pdf-reader]')
        ?.getAttribute('data-pdf-reader'),
    ).toBe('preview');
  });
});
