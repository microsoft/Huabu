// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OfficeNode, type OfficeNodeType } from '../office/OfficeNode';
import { PDFNode, type PDFNodeType } from '../pdf/PDFNode';
import { WebNode, type WebNodeType } from '../web/WebNode';

import type { NodeProps } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  getWebPreview: vi.fn(),
  thumbnail: vi.fn(),
  lod: 'full',
  hydrated: true,
  flowState: {
    transform: [0, 0, 0.24],
    nodeLookup: new Map<
      string,
      {
        style?: { width: number; height: number };
        measured?: { width: number; height: number };
      }
    >(),
  },
  state: {
    canvasId: 'canvas-1',
    updateNodeData: vi.fn(),
    ingestionByNodeId: {} as Record<string, { status: string }>,
  },
}));

vi.mock('@xyflow/react', () => ({
  useStore: (select: (state: typeof mocks.flowState) => unknown) =>
    select(mocks.flowState),
}));
vi.mock('@/api/web', () => ({ getWebPreview: mocks.getWebPreview }));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: (src: string, canvasId: string) =>
    `/api/canvas/${canvasId}/${src}`,
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (state: typeof mocks.state) => unknown) =>
    select(mocks.state),
}));
vi.mock('@/hooks/useNodeLOD', () => ({ useNodeLOD: () => mocks.lod }));
vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => ({
    mode: mocks.lod === 'minimal' ? 'minimal' : 'overview',
    isVisible: true,
    isSoleSelected: false,
    zoom: 1,
  }),
}));
vi.mock('../shared/nodeHydrationScheduler', () => ({
  useDeferredHydration: () => mocks.hydrated,
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: vi.fn(),
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../MissingFileBanner', () => ({
  getMissingFileKind: (data: { artifactMissing?: boolean }) =>
    data.artifactMissing ? 'missing' : null,
  MissingFileBanner: () => <div data-missing />,
}));
vi.mock('@/components/Common/FloatingToolbar', () => ({
  FloatingToolbar: { ActionButton: () => null },
}));
vi.mock('@/components/Common/Loading', () => ({
  Loading: ({ message }: { message?: string }) => (
    <div data-loading>{message}</div>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../pdf/PDFFirstPageThumbnail', () => ({
  default: (props: unknown) => {
    mocks.thumbnail(props);
    return <div data-thumbnail />;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lod = 'full';
  mocks.hydrated = true;
  mocks.flowState.nodeLookup.clear();
  mocks.state.ingestionByNodeId = {};
  mocks.getWebPreview.mockResolvedValue({
    label: 'Real web title',
    summary: 'Extracted summary',
    image: '/real-image.png',
    siteName: 'Local publication',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderWeb(
  data: Record<string, unknown> = {},
  dimensions = { width: 1600, height: 500 },
) {
  const props = {
    id: 'web-1',
    data: { src: 'https://example.com/real/article', ...data },
    ...dimensions,
  } as NodeProps<WebNodeType>;
  await act(async () => root.render(<WebNode {...props} />));
}

async function renderPdf(data: Record<string, unknown> = {}) {
  const props = {
    id: 'pdf-1',
    width: 900,
    height: 900,
    data: { src: 'original.pdf', label: 'Original PDF', ...data },
  } as NodeProps<PDFNodeType>;
  await act(async () => root.render(<PDFNode {...props} />));
}

describe('PDF and Web PreviewCard integration', () => {
  it.each([undefined, 'teal', 'white'])(
    'shares PDF surface colors with Office for accent %s',
    async (accent) => {
      await renderPdf({ style: { accent } });
      const pdf = container.querySelector<HTMLElement>('.preview-card');
      if (!pdf) throw new Error('Expected PDF card');
      const surface = pdf.style.getPropertyValue('--note-surface-background');
      const background = pdf.style.backgroundColor;
      const props = {
        id: 'office-1',
        data: { src: 'document.docx', format: 'docx', style: { accent } },
      } as NodeProps<OfficeNodeType>;
      await act(async () => root.render(<OfficeNode {...props} />));
      const office = container.querySelector<HTMLElement>(
        '[data-office-content] > div',
      );
      if (!office) throw new Error('Expected Office card');
      expect(office.classList.contains('bg-surface')).toBe(true);
      expect(office.style.getPropertyValue('--note-surface-background')).toBe(
        surface,
      );
      expect(office.style.backgroundColor).toBe(background);
      for (const section of Array.from(office.children)) {
        expect((section as HTMLElement).style.background).toBe('');
      }
    },
  );

  it('fills Web and PDF covers but keeps generated PDF pages complete', async () => {
    await renderWeb();
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('data-fit'),
    ).toBe('cover');
    await renderPdf({ coverUrl: 'cover.jpg' });
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('data-fit'),
    ).toBe('cover');
    await renderPdf();
    const captureProps = mocks.thumbnail.mock.lastCall?.[0] as {
      onCapture: (image: string) => void;
    };
    act(() => captureProps.onCapture('data:image/png;base64,example'));
    expect(
      container.querySelector('.preview-card__image')?.getAttribute('data-fit'),
    ).toBe('contain');
  });
  it('stops failed PDF captures, keeps metadata visible, and recovers for a new source', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderPdf({ summary: 'Still readable' });
    const failedProps = mocks.thumbnail.mock.lastCall?.[0] as {
      onError: (error: Error) => void;
    };
    const error = new Error('Invalid PDF structure');
    act(() => failedProps.onError(error));
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[PDFNode] First-page thumbnail failed',
      error,
    );
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('[data-loading]')).toBeNull();
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('PDF');
    expect(container.querySelector('h3')?.textContent).toBe('Original PDF');
    expect(container.querySelector('p')?.textContent).toBe('Still readable');
    expect(container.textContent).toContain('node.previewFailed');
    expect(
      container.querySelector('[title="Invalid PDF structure"]'),
    ).not.toBeNull();
    mocks.thumbnail.mockClear();
    await renderPdf({ label: 'Renamed without retry' });
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    await renderPdf({ src: 'recovered.pdf' });
    expect(mocks.thumbnail).toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    const recoveredProps = mocks.thumbnail.mock.lastCall?.[0] as {
      src: string;
      onCapture: (image: string) => void;
    };
    expect(recoveredProps.src).toBe('recovered.pdf');
    act(() => recoveredProps.onCapture('data:image/jpeg;base64,recovered'));
    act(() => container.querySelector('img')?.dispatchEvent(new Event('load')));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('node.previewFailed');
  });

  it('retries a failed PDF capture only when requested and restores its cover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderPdf({ summary: 'Saved PDF summary' });
    const failedProps = mocks.thumbnail.mock.lastCall?.[0] as {
      onError: (error: Error) => void;
    };
    act(() => failedProps.onError(new Error('Capture failed')));
    expect(container.querySelector('.preview-card__cover')).toBeNull();
    expect(container.querySelector('[data-thumbnail]')).toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Original PDF');
    expect(container.querySelector('p')?.textContent).toBe('Saved PDF summary');
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(container.textContent).not.toContain('node.previewFailed');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[data-thumbnail]')).not.toBeNull();
    const retriedProps = mocks.thumbnail.mock.lastCall?.[0] as {
      src: string;
      onCapture: (image: string) => void;
    };
    expect(retriedProps.src).toBe('original.pdf');
    act(() => retriedProps.onCapture('data:image/jpeg;base64,retried'));
    act(() => container.querySelector('img')?.dispatchEvent(new Event('load')));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,retried',
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('prefers live React Flow style and measured dimensions to stale node props', async () => {
    mocks.flowState.nodeLookup.set('web-1', {
      style: { width: 2500, height: 800 },
      measured: { width: 400, height: 400 },
    });
    await renderWeb({}, { width: 400, height: 400 });
    expect(
      container.querySelector('.preview-card')?.getAttribute('data-tier'),
    ).toBe('L');
    expect(
      container
        .querySelector('.preview-card')
        ?.getAttribute('data-orientation'),
    ).toBe('horizontal');
    mocks.flowState.nodeLookup.set('pdf-1', {
      measured: { width: 400, height: 400 },
    });
    await renderPdf({ coverUrl: 'cached.jpg' });
    expect(
      container.querySelector('.preview-card')?.getAttribute('data-tier'),
    ).toBe('S');
  });

  it('uses actual web dimensions and real hostname, title, image and summary', async () => {
    await renderWeb();
    expect(mocks.getWebPreview).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      nodeId: 'web-1',
    });
    expect(
      container
        .querySelector('.preview-card')
        ?.getAttribute('data-orientation'),
    ).toBe('horizontal');
    expect(
      container.querySelector('.preview-card')?.getAttribute('data-tier'),
    ).toBe('M');
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('example.com');
    expect(container.querySelector('h3')?.textContent).toBe('Real web title');
    expect(container.querySelector('p')?.textContent).toBe('Extracted summary');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/real-image.png',
    );
  });

  it('uses the extracted site name for local HTML', async () => {
    await renderWeb({ src: 'artifact-real.html' });
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('Local publication');
  });

  it('retains saved web metadata when extraction fails without a cover', async () => {
    mocks.getWebPreview.mockRejectedValue(new Error('Preview unavailable'));
    await renderWeb({ label: 'Saved title', summary: 'Saved summary' });
    expect(container.textContent).toContain('node.previewFailed');
    expect(
      container.querySelector('[title="Preview unavailable"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-loading]')).toBeNull();
    expect(container.querySelector('.preview-card__cover')).toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Saved title');
    expect(container.querySelector('p')?.textContent).toBe('Saved summary');
    expect(
      container.querySelectorAll('[title="Preview unavailable"]'),
    ).toHaveLength(1);
  });

  it('retries failed web extraction, immediately restores loading, and shows the successful cover', async () => {
    mocks.getWebPreview.mockRejectedValueOnce(new Error('Preview unavailable'));
    await renderWeb({ label: 'Saved title', summary: 'Saved summary' });
    expect(mocks.getWebPreview).toHaveBeenCalledTimes(1);
    let resolvePreview!: (value: {
      label: string;
      summary: string;
      image: string;
    }) => void;
    mocks.getWebPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(mocks.getWebPreview).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('node.previewFailed');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('.preview-card__cover')).not.toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Saved title');
    expect(container.querySelector('p')?.textContent).toBe('Saved summary');
    await act(async () =>
      resolvePreview({
        label: 'Recovered title',
        summary: 'Recovered summary',
        image: '/recovered.png',
      }),
    );
    act(() => container.querySelector('img')?.dispatchEvent(new Event('load')));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/recovered.png',
    );
    expect(container.querySelector('h3')?.textContent).toBe('Recovered title');
    expect(container.querySelector('p')?.textContent).toBe('Recovered summary');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('treats successful web extraction without an image as normal text-only content', async () => {
    mocks.getWebPreview.mockResolvedValue({
      label: 'Text-only article',
      summary: 'Useful article summary',
    });
    await renderWeb();
    expect(container.querySelector('.preview-card__cover')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('node.previewFailed');
    expect(container.querySelector('h3')?.textContent).toBe(
      'Text-only article',
    );
    expect(container.querySelector('p')?.textContent).toBe(
      'Useful article summary',
    );
  });

  it('shows cover loading and saved metadata while web hydration is deferred', async () => {
    mocks.hydrated = false;
    await renderWeb({ label: 'Saved title', summary: 'Saved summary' });
    expect(mocks.getWebPreview).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('.preview-card__cover')).not.toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Saved title');
    expect(container.querySelector('p')?.textContent).toBe('Saved summary');
    mocks.hydrated = true;
    await renderWeb({ label: 'Hydrated title' });
    expect(mocks.getWebPreview).toHaveBeenCalledTimes(1);
  });

  it('preserves pending ingestion and minimal-LOD fetch suppression', async () => {
    mocks.state.ingestionByNodeId['web-1'] = { status: 'pending' };
    await renderWeb({ label: 'Saved title', summary: 'Saved summary' });
    expect(mocks.getWebPreview).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe('Saved title');
    expect(container.querySelector('p')?.textContent).toBe('Saved summary');
    expect(
      container.querySelector('.preview-card__cover [data-loading]'),
    ).not.toBeNull();
    mocks.state.ingestionByNodeId = {};
    mocks.lod = 'minimal';
    await renderWeb({ label: 'Updated label' });
    expect(mocks.getWebPreview).not.toHaveBeenCalled();
  });

  it('uses resolved cached PDF images without loading pdf.js and handles broken covers', async () => {
    await renderPdf({ coverUrl: 'cached-cover.jpg' });
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    expect(
      container.querySelector('.preview-card')?.getAttribute('data-tier'),
    ).toBe('L');
    expect(
      container.querySelector('.preview-card__metadata')?.textContent,
    ).toBe('PDF');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/canvas/canvas-1/cached-cover.jpg',
    );
    act(() =>
      container.querySelector('img')?.dispatchEvent(new Event('error')),
    );
    expect(container.textContent).toContain('node.previewFailed');
    expect(container.querySelector('[data-loading]')).toBeNull();
  });

  it('defers uncached thumbnails and displays the real captured image', async () => {
    mocks.hydrated = false;
    await renderPdf();
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    mocks.hydrated = true;
    await renderPdf({ label: 'Ready to capture' });
    expect(mocks.thumbnail).toHaveBeenCalled();
    const props = mocks.thumbnail.mock.lastCall?.[0] as {
      src: string;
      onCapture: (image: string) => void;
    };
    expect(props.src).toBe('original.pdf');
    act(() => props.onCapture('data:image/jpeg;base64,real-capture'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,real-capture',
    );
  });

  it('preserves missing-file and absent-source messages', async () => {
    await renderPdf({ artifactMissing: true, coverUrl: 'cached.jpg' });
    expect(container.querySelector('[data-missing]')).not.toBeNull();
    expect(container.querySelector('.preview-card')).toBeNull();
    await renderPdf({ src: '' });
    expect(container.textContent).toBe('node.noPdfSource');
    await renderWeb({ src: '' });
    expect(container.textContent).toBe('node.invalidUrl');
  });
});
