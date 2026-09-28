// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PDFNode, type PDFNodeType } from './PDFNode';

import type { NodeProps } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  presentation: {
    mode: 'overview' as 'minimal' | 'overview' | 'reading',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  },
  hydrated: true,
  reader: vi.fn(),
  thumbnail: vi.fn(),
  updateNodeData: vi.fn(),
}));

vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => mocks.presentation,
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (state: unknown) => unknown) =>
    select({ canvasId: 'canvas-1', updateNodeData: mocks.updateNodeData }),
}));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: (src: string) => src,
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: vi.fn(),
}));
vi.mock('../shared/nodeHydrationScheduler', () => ({
  useDeferredHydration: () => mocks.hydrated,
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({ children }: { children: ReactNode }) => (
    <div data-wrapper>{children}</div>
  ),
}));
vi.mock('../MissingFileBanner', () => ({
  getMissingFileKind: (data: { artifactMissing?: boolean }) =>
    data.artifactMissing ? 'missing' : null,
  MissingFileBanner: () => <div data-missing />,
}));
vi.mock('../previewCard/PreviewCard', () => ({
  usePreviewCardSize: () => ({ width: 800, height: 600 }),
  ViewportPreviewCard: ({ title }: { title: string }) => (
    <div data-overview>{title}</div>
  ),
}));
vi.mock('@/components/Common/FloatingToolbar', () => ({
  FloatingToolbar: { ActionButton: () => null },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./PDFFirstPageThumbnail', () => ({
  default: (props: unknown) => {
    mocks.thumbnail(props);
    return <div data-thumbnail />;
  },
}));
vi.mock('./PDFPreview', () => ({
  PDFPreview: (props: { embedded: boolean; interactive: boolean }) => {
    mocks.reader(props);
    return <div data-reader data-interactive={props.interactive} />;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.presentation = {
    mode: 'overview',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  };
  mocks.hydrated = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(data: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(
      <PDFNode
        {...({
          id: 'pdf-1',
          width: 800,
          height: 600,
          data: { src: 'document.pdf', label: 'Original PDF', ...data },
        } as NodeProps<PDFNodeType>)}
      />,
    ),
  );
}

describe('PDF canvas presentation', () => {
  it('keeps the overview and thumbnail pipeline at intermediate size', async () => {
    await render();
    expect(container.querySelector('[data-overview]')?.textContent).toBe(
      'Original PDF',
    );
    expect(container.querySelector('[data-thumbnail]')).not.toBeNull();
    expect(mocks.reader).not.toHaveBeenCalled();
  });

  it.each(['minimal', 'reading'] as const)(
    'does not mount a reader or capture offscreen in %s mode',
    async (mode) => {
      mocks.presentation.mode = mode;
      mocks.presentation.isVisible = false;
      await render();
      expect(container.querySelector('[data-overview]')).not.toBeNull();
      expect(container.querySelector('[data-pdf-reading-surface]')).toBeNull();
      expect(mocks.reader).not.toHaveBeenCalled();
      expect(mocks.thumbnail).not.toHaveBeenCalled();
    },
  );

  it('keeps a visible minimal card without heavy work', async () => {
    mocks.presentation.mode = 'minimal';
    await render();
    expect(container.querySelector('[data-wrapper]')).not.toBeNull();
    expect(mocks.reader).not.toHaveBeenCalled();
    expect(mocks.thumbnail).not.toHaveBeenCalled();
  });

  it.each([0.05, 0.5, 1, 2])(
    'renders canvas PDF pages in screen-sized geometry at zoom %s',
    async (zoom) => {
      mocks.presentation.mode = 'reading';
      mocks.presentation.zoom = zoom;
      await render();
      const surface = container.querySelector<HTMLElement>(
        '[data-pdf-reading-surface]',
      );
      expect(surface?.style.transform).toBe(`scale(${1 / zoom})`);
      expect(surface?.style.transformOrigin).toBe('top left');
      expect(surface?.style.width).toBe(`${zoom * 100}%`);
      expect(surface?.style.height).toBe(`${zoom * 100}%`);
      expect(surface?.classList.contains('shrink-0')).toBe(true);
      expect(surface?.querySelector('[data-reader]')).not.toBeNull();
      expect(surface?.querySelector('[data-overview]')).toBeNull();
    },
  );

  it('updates screen-sized reader geometry without remounting on zoom changes', async () => {
    mocks.presentation.mode = 'reading';
    mocks.presentation.zoom = 0.5;
    await render();
    const surface = container.querySelector('[data-pdf-reading-surface]');
    const reader = container.querySelector('[data-reader]');
    mocks.presentation.zoom = 0.75;
    await render();
    expect(container.querySelector('[data-pdf-reading-surface]')).toBe(surface);
    expect(container.querySelector('[data-reader]')).toBe(reader);
    expect((surface as HTMLElement).style.width).toBe('75%');
  });

  it('waits for hydration, then renders real pages without a duplicate capture', async () => {
    mocks.presentation.mode = 'reading';
    mocks.hydrated = false;
    await render();
    expect(container.querySelector('[data-overview]')).not.toBeNull();
    expect(mocks.reader).not.toHaveBeenCalled();
    mocks.hydrated = true;
    await render();
    expect(container.querySelector('[data-overview]')).toBeNull();
    expect(mocks.reader).toHaveBeenLastCalledWith(
      expect.objectContaining({ embedded: true, interactive: false }),
    );
    expect(mocks.thumbnail).not.toHaveBeenCalled();
  });

  it('only enables input for sole selection and releases the reader offscreen', async () => {
    mocks.presentation.mode = 'reading';
    await render({ coverUrl: 'cover.jpg' });
    expect(
      container
        .querySelector('[data-reader]')
        ?.getAttribute('data-interactive'),
    ).toBe('false');
    mocks.presentation.isSoleSelected = true;
    await render({ coverUrl: 'cover.jpg' });
    expect(
      container
        .querySelector('[data-reader]')
        ?.getAttribute('data-interactive'),
    ).toBe('true');
    mocks.presentation.isSoleSelected = false;
    await render({ coverUrl: 'cover.jpg' });
    expect(
      container
        .querySelector('[data-reader]')
        ?.getAttribute('data-interactive'),
    ).toBe('false');
    mocks.presentation.isVisible = false;
    await render({ coverUrl: 'cover.jpg' });
    expect(container.querySelector('[data-reader]')).toBeNull();
    expect(container.querySelector('[data-overview]')).not.toBeNull();
  });

  it('preserves missing-file and empty-source states in reading mode', async () => {
    mocks.presentation.mode = 'reading';
    await render({ artifactMissing: true });
    expect(container.querySelector('[data-missing]')).not.toBeNull();
    expect(mocks.reader).not.toHaveBeenCalled();
    await render({ src: '' });
    expect(container.textContent).toContain('node.noPdfSource');
    expect(mocks.reader).not.toHaveBeenCalled();
  });
});
