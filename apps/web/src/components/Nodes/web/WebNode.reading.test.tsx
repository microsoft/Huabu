// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PropertySymbol, type Window as HappyWindow } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebNode, type WebNodeType } from './WebNode';

import type { CanvasWebNodeData } from '../types';
import type { NodeProps } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  presentation: {
    mode: 'overview' as 'minimal' | 'overview' | 'reading',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  },
  getWebPreview: vi.fn(),
  getWebPage: vi.fn(),
  getWebReader: vi.fn(),
  openPreviewNode: vi.fn(),
  bridge: vi.fn(),
  bridgeLoad: vi.fn(),
  resolveArtifactUrl: vi.fn(
    (src: string, canvasId: string) =>
      `/api/canvas/${canvasId}/artifact/${src}`,
  ),
  missing: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => mocks.presentation,
}));
vi.mock('@/api/web', () => ({
  getWebPreview: mocks.getWebPreview,
  getWebPage: mocks.getWebPage,
  getWebReader: mocks.getWebReader,
}));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: mocks.resolveArtifactUrl,
}));
vi.mock('./useInteractiveViewBridge', () => ({
  useInteractiveViewBridge: (input: unknown) => {
    mocks.bridge(input);
    return { onLoad: mocks.bridgeLoad };
  },
}));
vi.mock('@/store/canvasStore', () => ({
  default: (
    selector: (state: {
      canvasId: string;
      ingestionByNodeId: Record<string, never>;
    }) => unknown,
  ) => selector({ canvasId: 'canvas-1', ingestionByNodeId: {} }),
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: mocks.openPreviewNode,
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({
    children,
    actions,
    overflow,
  }: {
    children: ReactNode;
    actions: ReactNode;
    overflow: ReactNode;
  }) => (
    <MemoryRouter>
      <div>
        <div data-node-actions>
          {actions}
          {overflow}
        </div>
        {children}
      </div>
    </MemoryRouter>
  ),
}));
vi.mock('../previewCard/PreviewCard', () => ({
  ViewportPreviewCard: () => <div data-preview-card />,
  usePreviewCardSize: () => ({ width: 800, height: 500 }),
}));
vi.mock('../MissingFileBanner', () => ({
  getMissingFileKind: () => (mocks.missing ? 'source' : null),
  MissingFileBanner: () => <div data-missing-file />,
}));
vi.mock('../shared/nodeHydrationScheduler', () => ({
  useDeferredHydration: () => true,
}));
vi.mock('@/components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const browserWindow = (
  document as unknown as { [PropertySymbol.window]: HappyWindow }
)[PropertySymbol.window];

beforeEach(() => {
  // Keep real iframe attributes/events without Happy DOM loading remote pages.
  vi.spyOn(
    browserWindow.HTMLIFrameElement.prototype,
    PropertySymbol.connectedToDocument,
  ).mockImplementation(() => {});
  vi.clearAllMocks();
  mocks.presentation = {
    mode: 'overview',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  };
  mocks.missing = false;
  mocks.getWebPreview.mockResolvedValue({
    label: 'Original website',
    summary: 'Existing summary',
  });
  mocks.getWebPage.mockResolvedValue({ kind: 'html', src: 'art_page.html' });
  mocks.getWebReader.mockResolvedValue({ html: '<p>Extracted text</p>' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = container.querySelector<T>(selector);
  if (!result) throw new Error(`Missing element: ${selector}`);
  return result;
}

/** Present once the Server has extracted the page's text. */
const EXTRACTED: Partial<CanvasWebNodeData> = { content: 'Extracted text' };

async function render(data: Partial<CanvasWebNodeData> = {}) {
  await act(async () => {
    root.render(
      <WebNode
        {...({
          id: 'web-1',
          data: {
            src: 'https://example.com/original',
            ...EXTRACTED,
            ...data,
          },
          selected: mocks.presentation.isSoleSelected,
          width: 800,
          height: 500,
        } as NodeProps<WebNodeType>)}
      />,
    );
  });
}

describe('WebNode reading presentation', () => {
  it('keeps the existing overview and metadata pipeline without a live iframe', async () => {
    await render();
    expect(container.querySelector('[data-preview-card]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(mocks.getWebPreview).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      nodeId: 'web-1',
    });
    expect(mocks.getWebPage).not.toHaveBeenCalled();
  });

  it('shows another site as its reader view and never loads the site', async () => {
    mocks.presentation.mode = 'reading';
    await render();
    const iframe = element('iframe');
    expect(iframe.hasAttribute('src')).toBe(false);
    expect(iframe.getAttribute('srcdoc')).toContain('<p>Extracted text</p>');
    expect(iframe.getAttribute('sandbox')).toBe('allow-popups allow-scripts');
    expect(mocks.getWebReader).toHaveBeenCalledExactlyOnceWith({
      canvasId: 'canvas-1',
      nodeId: 'web-1',
    });
    expect(mocks.getWebPage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-preview-card]')).toBeNull();
  });

  it('keeps the overview card for another site that has no reader view', async () => {
    mocks.presentation.mode = 'reading';
    mocks.getWebReader.mockRejectedValue(
      new Error('Source has no content yet'),
    );
    await render();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-preview-card]')).not.toBeNull();

    // Before the Server has extracted anything there is nothing to ask for.
    mocks.getWebReader.mockClear();
    await render({ src: 'https://example.com/other', content: '' });
    expect(mocks.getWebReader).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-preview-card]')).not.toBeNull();
    expect(mocks.getWebPage).not.toHaveBeenCalled();
  });

  it('keeps a header-free reader viewport in screen pixels across zoom changes', async () => {
    mocks.presentation.mode = 'reading';
    mocks.presentation.zoom = 0.5;
    await render();
    const reader = element('[data-web-reading]');
    const iframe = element('iframe');
    expect(reader.style.width).toBe('50%');
    expect(reader.style.height).toBe('50%');
    expect(reader.style.transform).toBe('scale(2)');
    expect(reader.style.transformOrigin).toBe('top left');
    expect(reader.contains(iframe)).toBe(true);
    expect(
      reader.querySelector('button, [title="https://example.com/original"]'),
    ).toBeNull();
    expect(reader.children).toHaveLength(1);

    mocks.presentation.zoom = 2;
    await render();
    expect(element('iframe')).toBe(iframe);
    expect(reader.style.width).toBe('200%');
    expect(reader.style.height).toBe('200%');
    expect(reader.style.transform).toBe('scale(0.5)');
  });

  it('shows detectable iframe errors and permits retry without selection', async () => {
    mocks.presentation.mode = 'reading';
    await render({ src: 'art_page.html' });
    const iframe = element('iframe');
    act(() => iframe.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('node.failedLoadPage');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-web-interaction-shield]')).toBeNull();
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'messages.retry',
    );
    if (!retry) throw new Error('Missing retry button');
    await act(async () => retry.click());
    expect(element('iframe')).not.toBe(iframe);
    expect(element('iframe').getAttribute('src')).toBe(
      '/api/canvas/canvas-1/artifact/art_page.html',
    );
    expect(container.textContent).not.toContain('node.failedLoadPage');
    expect(
      container.querySelector('[data-web-interaction-shield]'),
    ).not.toBeNull();
  });

  it('shields unselected and multi-selected pages and enables only sole selection', async () => {
    mocks.presentation.mode = 'reading';
    await render();
    let page = element('[data-web-reader]');
    expect(page.hasAttribute('inert')).toBe(true);
    expect(page.className).toContain('pointer-events-none');
    const shield = element('[data-web-interaction-shield]');
    const wheel = vi.fn();
    container.addEventListener('wheel', wheel);
    shield.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(wheel).toHaveBeenCalledOnce();

    mocks.presentation.isSoleSelected = true;
    await render();
    expect(element('[data-web-reader]')).toBe(page);
    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.className).toContain('nowheel');
    expect(container.querySelector('[data-web-interaction-shield]')).toBeNull();

    mocks.presentation.isSoleSelected = false;
    await render();
    page = element('[data-web-reader]');
    expect(page.hasAttribute('inert')).toBe(true);
    expect(
      container.querySelector('[data-web-interaction-shield]'),
    ).not.toBeNull();
  });

  it('unmounts reading views offscreen, in overview, and in minimal presentation', async () => {
    mocks.presentation.mode = 'reading';
    await render();
    expect(container.querySelector('iframe')).not.toBeNull();
    mocks.presentation.isVisible = false;
    await render();
    expect(container.querySelector('iframe')).toBeNull();
    mocks.presentation.isVisible = true;
    await render();
    expect(container.querySelector('iframe')).not.toBeNull();
    for (const mode of ['overview', 'minimal'] as const) {
      mocks.presentation.mode = mode;
      await render();
      expect(container.querySelector('iframe')).toBeNull();
    }
  });

  it('keeps the original-site action in the existing toolbar, outside the reader', async () => {
    mocks.presentation.mode = 'reading';
    await render();
    const link = element<HTMLAnchorElement>(
      '[data-node-actions] a[href="https://example.com/original"]',
    );
    expect(link.closest('[inert]')).toBeNull();
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(element('[data-node-actions]').textContent).not.toContain(
      'node.download',
    );
    expect(element('[data-web-reading]').contains(link)).toBe(false);
  });

  it('never loads a remote URL, even one that names the app origin', async () => {
    mocks.presentation.mode = 'reading';
    await render({ src: `${window.location.origin}/app` });
    expect(element('iframe').hasAttribute('src')).toBe(false);
    expect(mocks.getWebPage).not.toHaveBeenCalled();
  });

  it('resolves local HTML using the existing artifact API', async () => {
    mocks.presentation.mode = 'reading';
    await render({ src: 'art_page.html' });
    expect(mocks.getWebPage).toHaveBeenCalledExactlyOnceWith({
      canvasId: 'canvas-1',
      nodeId: 'web-1',
    });
    expect(mocks.resolveArtifactUrl).toHaveBeenCalledWith(
      'art_page.html',
      'canvas-1',
    );
    expect(element('iframe').getAttribute('src')).toBe(
      '/api/canvas/canvas-1/artifact/art_page.html',
    );
    expect(element('iframe').getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms',
    );
    act(() =>
      element<HTMLButtonElement>(
        '[data-node-actions] button[aria-label="node.openLargeView"]',
      ).click(),
    );
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('web-1');
  });

  it('does not run snapshot scripts and never substitutes snapshots for remote sources', async () => {
    mocks.presentation.mode = 'reading';
    mocks.getWebPage.mockResolvedValue({
      kind: 'html',
      src: 'art_page.mhtml',
      snapshot: true,
    });
    await render({ src: 'art_page.mhtml' });
    expect(element('iframe').getAttribute('sandbox')).toBe('');
    await render();
    expect(element('iframe').hasAttribute('src')).toBe(false);
    expect(mocks.getWebPage).toHaveBeenCalledTimes(1);
  });

  it('renders interactive views through the existing renderer and shared bridge', async () => {
    mocks.presentation.mode = 'reading';
    mocks.getWebPage.mockResolvedValue({
      kind: 'html',
      src: '/api/interactive-views/canvas-1/web-1/renderer',
    });
    await render({
      src: 'art_interactive.html',
      interactiveView: {} as CanvasWebNodeData['interactiveView'],
    });
    expect(container.querySelector('[data-preview-card]')).toBeNull();
    expect(element('[data-node-actions]').textContent).toContain(
      'node.download',
    );
    expect(mocks.resolveArtifactUrl).toHaveBeenCalledWith(
      '/api/interactive-views/canvas-1/web-1/renderer',
      'canvas-1',
    );
    expect(element('iframe').getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms',
    );
    expect(element('iframe').hasAttribute('inert')).toBe(true);
    expect(mocks.bridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        canvasId: 'canvas-1',
        nodeId: 'web-1',
      }),
    );
    act(() => element('iframe').dispatchEvent(new Event('load')));
    expect(mocks.bridgeLoad).toHaveBeenCalledOnce();
    const iframe = element('iframe');
    mocks.presentation.isSoleSelected = true;
    await render({
      src: 'art_interactive.html',
      interactiveView: {} as CanvasWebNodeData['interactiveView'],
    });
    expect(element('iframe')).toBe(iframe);
    expect(iframe.hasAttribute('inert')).toBe(false);
    mocks.presentation.isVisible = false;
    await render({
      src: 'art_interactive.html',
      interactiveView: {} as CanvasWebNodeData['interactiveView'],
    });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it.each([
    [
      'https://example.com/original',
      { kind: 'url', src: 'https://example.com/original' },
    ],
    ['snapshot.mhtml', { kind: 'html', src: 'snapshot.mhtml', snapshot: true }],
    ['art_page.html', { kind: 'url', src: 'https://example.com/redirect' }],
  ])('does not attach a capability bridge to %s', async (src, page) => {
    mocks.presentation.mode = 'reading';
    mocks.getWebPage.mockResolvedValue(page);
    await render({
      src,
      interactiveView: {} as CanvasWebNodeData['interactiveView'],
    });
    expect(mocks.bridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('preserves missing-file UI without mounting or resolving a page', async () => {
    mocks.presentation.mode = 'reading';
    mocks.missing = true;
    await render({ src: 'art_missing.html' });
    expect(container.querySelector('[data-missing-file]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(mocks.getWebPage).not.toHaveBeenCalled();
  });

  it('preserves the invalid URL message for empty sources in reading mode', async () => {
    mocks.presentation.mode = 'reading';
    await render({ src: '' });
    expect(container.textContent).toContain('node.invalidUrl');
    expect(container.querySelector('iframe')).toBeNull();
    expect(mocks.getWebPage).not.toHaveBeenCalled();
  });

  it('keeps an expanded-view escape when local resolution fails', async () => {
    mocks.presentation.mode = 'reading';
    mocks.getWebPage.mockRejectedValue(new Error('Missing artifact'));
    await render({ src: 'art_missing.html' });
    expect(container.textContent).toContain('node.failedLoadPage');
    expect(container.querySelector('iframe')).toBeNull();
    expect(
      container.querySelector(
        '[data-node-actions] button[aria-label="node.openLargeView"]',
      ),
    ).not.toBeNull();
  });
});
