// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicePdfLoadError } from '@/api/device-files';
import useCanvasStore from '@/store/canvasStore';

import { FileReferencePreview } from './FileReferencePreview';

import type * as DeviceFilesApi from '@/api/device-files';
import type * as NodeDownloadModule from '@/utils/io/nodeDownload';
import type * as ReactI18next from 'react-i18next';

interface MockDocumentProps {
  file: unknown;
  children?: ReactNode;
  onLoadSuccess?: (doc: { numPages: number }) => void;
  onPassword?: (callback: (password: string) => void, reason: number) => void;
  onLoadError?: (error: Error) => void;
}

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  loadPdf: vi.fn(),
  loadBytes: vi.fn(),
  triggerDownload: vi.fn(),
  openFileReference: vi.fn(),
  closePreviewFile: vi.fn(),
  documentProps: null as MockDocumentProps | null,
  pageProps: [] as Array<{ pageNumber: number; pageWidth?: number }>,
  t: (key: string, options?: Record<string, unknown>) =>
    options?.count !== undefined
      ? `${key}:${options.count}`
      : options?.limitMiB !== undefined
        ? `${key}:${options.limitMiB}`
        : key,
}));

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof ReactI18next>()),
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock('@/api/device-files', async (original) => {
  const actual = await original<typeof DeviceFilesApi>();
  return {
    ...actual,
    readDeviceFile: mocks.readText,
    loadDevicePdfBytes: mocks.loadPdf,
    loadDeviceFileBytes: mocks.loadBytes,
  };
});

vi.mock('@/utils/io/nodeDownload', async (original) => ({
  ...(await original<typeof NodeDownloadModule>()),
  triggerBlobDownload: mocks.triggerDownload,
}));

vi.mock('@/store/previewWorkspace/actions', () => ({
  openFileReference: mocks.openFileReference,
  closePreviewFile: mocks.closePreviewFile,
}));

vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <div data-loading />,
}));

vi.mock('@/components/Nodes/pdf/pdfWorker', () => ({
  PDF_DOCUMENT_OPTIONS: {},
}));

vi.mock('react-pdf', () => ({
  Document: (props: MockDocumentProps) => {
    mocks.documentProps = props;
    return <div data-testid="pdf-document">{props.children}</div>;
  },
  Page: (props: { pageNumber: number; width?: number }) => {
    mocks.pageProps.push({
      pageNumber: props.pageNumber,
      pageWidth: props.width,
    });
    return <div data-testid={`pdf-page-${props.pageNumber}`} />;
  },
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}));

const samplePdfBytes = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
]);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.documentProps = null;
  mocks.pageProps = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        this.cb(
          [
            {
              contentRect: { width: 800, height: 1000 } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useCanvasStore.setState({
    canvasId: 'space-1',
    canvasAccess: { canvasId: 'space-1', write: true, manage: true },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('DevicePdfPreview via FileReferencePreview', () => {
  it('renders a node-free PDF preview without UTF-8 reads or Space mutations, and hands Add to Space over to a fileReference node', async () => {
    mocks.loadPdf.mockResolvedValue({
      bytes: samplePdfBytes,
      size: samplePdfBytes.length,
      contentVersion: 'a'.repeat(64),
      path: '/papers/attention.PDF',
    });

    const reference = {
      agentletId: 'dev-linux',
      path: '/papers/attention.PDF',
      deviceName: 'Workstation',
    };

    await act(async () => {
      root.render(<FileReferencePreview data={{ fileReference: reference }} />);
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="pdf-document"]')).not.toBeNull(),
    );
    await act(async () => {});

    expect(mocks.readText).not.toHaveBeenCalled();
    expect(mocks.loadPdf).toHaveBeenCalledWith(
      'dev-linux',
      '/papers/attention.PDF',
      expect.objectContaining({ maxBytes: 33_554_432 }),
    );
    expect(mocks.documentProps?.file).toBeInstanceOf(Blob);

    await act(async () => {
      mocks.documentProps?.onLoadSuccess?.({ numPages: 3 });
    });

    expect(host.textContent).toContain('Workstation · /papers/attention.PDF');
    expect(host.textContent).toContain('files.pdfPageCount:3');
    expect(host.querySelector('[data-testid="pdf-page-1"]')).not.toBeNull();
    // No node-only capture/excerpt/highlight UI is mounted.
    expect(host.querySelector('[data-pdf-text-drag]')).toBeNull();

    const addButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'files.addToSpace',
    );
    expect(addButton).toBeDefined();
    await act(async () => {
      addButton?.click();
    });
    expect(mocks.openFileReference).toHaveBeenCalledWith(
      'space-1',
      reference,
      'attention.PDF',
    );
    expect(mocks.closePreviewFile).toHaveBeenCalledWith(reference);
  });

  it('allows read-only Space browsing while hiding Add to Space when Space is read-only or already backed by a fileReference node', async () => {
    mocks.loadPdf.mockResolvedValue({
      bytes: samplePdfBytes,
      size: samplePdfBytes.length,
      contentVersion: 'b'.repeat(64),
      path: '/papers/spec.pdf',
    });
    useCanvasStore.setState({
      canvasId: 'space-ro',
      canvasAccess: { canvasId: 'space-ro', write: false, manage: false },
    });

    await act(async () => {
      root.render(
        <FileReferencePreview
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/spec.pdf',
            },
          }}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="pdf-document"]')).not.toBeNull(),
    );
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === 'files.addToSpace',
      ),
    ).toBe(false);

    // Even in a writable Space, an existing fileReference node omits Add to Space.
    useCanvasStore.setState({
      canvasId: 'space-1',
      canvasAccess: { canvasId: 'space-1', write: true, manage: true },
    });
    await act(async () => {
      root.render(
        <FileReferencePreview
          id="existing-file-ref"
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/spec.pdf',
            },
          }}
        />,
      );
    });
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === 'files.addToSpace',
      ),
    ).toBe(false);
  });

  it('fails informatively on password-protected PDFs without calling window.prompt', async () => {
    const promptSpy = vi.fn();
    vi.stubGlobal('prompt', promptSpy);
    mocks.loadPdf.mockResolvedValue({
      bytes: samplePdfBytes,
      size: samplePdfBytes.length,
      contentVersion: 'c'.repeat(64),
      path: '/papers/secret.pdf',
    });

    await act(async () => {
      root.render(
        <FileReferencePreview
          id="node-ref"
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/secret.pdf',
            },
          }}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.documentProps).not.toBeNull());

    await act(async () => {
      mocks.documentProps?.onPassword?.(vi.fn(), 1);
    });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'files.pdfEncrypted',
    );
    expect(host.querySelector('[data-testid="pdf-document"]')).toBeNull();
  });

  it.each([
    [new DevicePdfLoadError('too_large', 'Too large'), 'files.pdfTooLarge:32'],
    [
      new DevicePdfLoadError('proxy_incompatible', 'Update Agentlet'),
      'files.pdfProxyIncompatible',
    ],
    [new DevicePdfLoadError('offline', 'Offline'), 'files.offline'],
    [new DevicePdfLoadError('invalid_pdf', 'Invalid'), 'files.pdfInvalid'],
  ])('renders explicit alert for %o', async (failure, expectedAlert) => {
    mocks.loadPdf.mockRejectedValueOnce(failure);

    await act(async () => {
      root.render(
        <FileReferencePreview
          data={{
            fileReference: { agentletId: 'dev-linux', path: '/papers/bad.pdf' },
          }}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        expectedAlert,
      ),
    );
  });

  it('aborts in-flight binary reads when switching to another file', async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.loadPdf
      .mockImplementationOnce(
        (
          _agentletId: string,
          _path: string,
          options?: { signal?: AbortSignal },
        ) => {
          firstSignal = options?.signal;
          return new Promise(() => {});
        },
      )
      .mockResolvedValueOnce({
        bytes: samplePdfBytes,
        size: samplePdfBytes.length,
        contentVersion: 'e'.repeat(64),
        path: '/papers/second.pdf',
      });

    await act(async () => {
      root.render(
        <FileReferencePreview
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/first.pdf',
            },
          }}
        />,
      );
    });
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    expect(firstSignal?.aborted).toBe(false);

    await act(async () => {
      root.render(
        <FileReferencePreview
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/second.pdf',
            },
          }}
        />,
      );
    });
    expect(firstSignal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="pdf-document"]')).not.toBeNull(),
    );
    expect(host.textContent).toContain('/papers/second.pdf');
  });

  it('downloads the already-loaded PDF Blob immediately without re-fetching from the device', async () => {
    mocks.loadPdf.mockResolvedValue({
      bytes: samplePdfBytes,
      size: samplePdfBytes.length,
      contentVersion: 'f'.repeat(64),
      path: '/papers/attention.PDF',
    });

    await act(async () => {
      root.render(
        <FileReferencePreview
          data={{
            fileReference: {
              agentletId: 'dev-linux',
              path: '/papers/attention.PDF',
            },
          }}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="pdf-document"]')).not.toBeNull(),
    );

    const downloadButton = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'files.download',
    );
    expect(downloadButton).toBeDefined();
    await act(async () => {
      downloadButton?.click();
    });

    expect(mocks.loadBytes).not.toHaveBeenCalled();
    expect(mocks.triggerDownload).toHaveBeenCalledOnce();
    expect(mocks.triggerDownload.mock.calls[0]?.[0]).toBe(
      mocks.documentProps?.file,
    );
    expect(mocks.triggerDownload.mock.calls[0]?.[1]).toBe('attention.pdf');
  });
});
