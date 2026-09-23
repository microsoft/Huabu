// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FirstPageThumbnail } from './PDFFirstPageThumbnail';

interface DocumentProps {
  children: ReactNode;
  onSourceError: (error: Error) => void;
  onLoadError: (error: Error) => void;
}

interface PageProps {
  onLoadError: (error: Error) => void;
  onRenderError: (error: Error) => void;
  onRenderSuccess: (page: { width: number }) => void;
}

const mocks = vi.hoisted(() => ({
  document: vi.fn<(props: DocumentProps) => void>(),
  page: vi.fn<(props: PageProps) => void>(),
}));

vi.mock('react-pdf', () => ({
  Document: (props: DocumentProps) => {
    mocks.document(props);
    return <>{props.children}</>;
  },
  Page: (props: PageProps) => {
    mocks.page(props);
    return <canvas />;
  },
}));
vi.mock('@/api/artifact', () => ({
  resolveArtifactUrl: (src: string) => src,
}));
vi.mock('./pdfWorker', () => ({ PDF_DOCUMENT_OPTIONS: {} }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render() {
  const onCapture = vi.fn();
  const onError = vi.fn();
  act(() =>
    root.render(
      <FirstPageThumbnail
        src="real.pdf"
        canvasId="canvas-1"
        onCapture={onCapture}
        onError={onError}
      />,
    ),
  );
  const document = mocks.document.mock.lastCall?.[0];
  const page = mocks.page.mock.lastCall?.[0];
  if (!document || !page) throw new Error('Missing PDF render callbacks');
  return { onCapture, onError, document, page };
}

describe('FirstPageThumbnail', () => {
  it.each([
    ['document', 'onSourceError'],
    ['document', 'onLoadError'],
    ['page', 'onLoadError'],
    ['page', 'onRenderError'],
  ] as const)(
    'reports %s %s once and does not capture after failure',
    (target, event) => {
      const callbacks = render();
      const error = new Error('Unreadable PDF');
      const onFailure =
        target === 'document'
          ? callbacks.document[event as 'onSourceError' | 'onLoadError']
          : callbacks.page[event as 'onLoadError' | 'onRenderError'];
      act(() => {
        onFailure(error);
        onFailure(error);
        callbacks.page.onRenderSuccess({ width: 400 });
      });
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(callbacks.onCapture).not.toHaveBeenCalled();
    },
  );

  it('reports canvas encoding failures instead of leaving capture pending', () => {
    const callbacks = render();
    const error = new Error('Canvas encoding failed');
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => {
        throw error;
      },
    );
    act(() => callbacks.page.onRenderSuccess({ width: 400 }));
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(callbacks.onCapture).not.toHaveBeenCalled();
  });

  it('captures the actual JPEG once and ignores late render errors', () => {
    const callbacks = render();
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,captured');
    act(() => {
      callbacks.page.onRenderSuccess({ width: 400 });
      callbacks.page.onRenderSuccess({ width: 400 });
      callbacks.page.onRenderError(new Error('Late render error'));
    });
    expect(encode).toHaveBeenCalledExactlyOnceWith('image/jpeg', 0.85);
    expect(callbacks.onCapture).toHaveBeenCalledExactlyOnceWith(
      'data:image/jpeg;base64,captured',
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
