// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Document } from 'react-pdf';

import {
  DevicePdfLoadError,
  loadDevicePdfBytes,
  MAX_DEVICE_PDF_BYTES,
  type DevicePdfErrorKind,
} from '@/api/device-files';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import {
  DEFAULT_PDF_PAGE_ASPECT_RATIO,
  updateRetainedPdfPages,
  updateVisiblePdfPages,
} from '@/components/Nodes/pdf/pdfPageRendering';
import { PDFPageWithOverlay } from '@/components/Nodes/pdf/PDFPageWithOverlay';
import { PDF_DOCUMENT_OPTIONS } from '@/components/Nodes/pdf/pdfWorker';
import { PDFZoomControls } from '@/components/Nodes/pdf/PDFZoomControls';
import { usePdfDocumentLifecycle } from '@/components/Nodes/pdf/usePdfDocumentLifecycle';
import { usePdfZoom } from '@/components/Nodes/pdf/usePdfZoom';
import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import useCanvasStore, { selectCanWriteCanvas } from '@/store/canvasStore';
import {
  closePreviewFile,
  openFileReference,
} from '@/store/previewWorkspace/actions';
import { readPdfPreviewView } from '@/store/previewWorkspace/scrollMemory';
import { deviceFileName } from '@/utils/deviceFile';

import type { FileReference } from '@huabu/shared';

type PdfViewerErrorKind = DevicePdfErrorKind | 'encrypted';

function formatByteSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export interface DevicePdfPreviewProps {
  id?: string;
  reference: FileReference;
  scrollViewKey?: string;
}

export function DevicePdfPreview({
  id,
  reference,
  scrollViewKey,
}: DevicePdfPreviewProps) {
  const { t } = useTranslation();
  const { agentletId, path } = reference;
  const fileIdentity = `${agentletId}\0${path}`;
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canWrite = useCanvasStore(selectCanWriteCanvas);

  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{
    loadedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [loadedPdf, setLoadedPdf] = useState<{
    identity: string;
    blob: Blob;
    contentVersion: string;
    size: number;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    identity: string;
    kind: PdfViewerErrorKind;
    detail?: string;
  } | null>(null);

  const generation = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const activePdf = loadedPdf?.identity === fileIdentity ? loadedPdf : null;
  const activeError = errorState?.identity === fileIdentity ? errorState : null;
  const sourceKey = activePdf
    ? `${fileIdentity}\0${activePdf.contentVersion}\0${refresh}`
    : fileIdentity;

  const {
    numPages,
    isLoaded: docLoaded,
    handleLoadSuccess: onDocumentLoadSuccess,
  } = usePdfDocumentLifecycle(sourceKey);

  const [visiblePageIndexes, setVisiblePageIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set([0]));
  const [retainedPageIndexes, setRetainedPageIndexes] = useState<
    ReadonlySet<number>
  >(() => new Set([0]));
  const [pageAspectRatios, setPageAspectRatios] = useState<
    ReadonlyMap<number, number>
  >(() => {
    const saved = readPdfPreviewView(scrollViewKey);
    return saved?.source === sourceKey
      ? new Map([[0, saved.aspectRatio]])
      : new Map();
  });
  const [naturalPageWidth, setNaturalPageWidth] = useState(() => {
    const saved = readPdfPreviewView(scrollViewKey);
    return saved?.source === sourceKey ? saved.naturalWidth : 612;
  });

  useEffect(() => {
    setVisiblePageIndexes(new Set([0]));
    setRetainedPageIndexes(new Set([0]));
    const saved = readPdfPreviewView(scrollViewKey);
    setPageAspectRatios(
      saved?.source === sourceKey
        ? new Map([[0, saved.aspectRatio]])
        : new Map(),
    );
    setNaturalPageWidth(saved?.source === sourceKey ? saved.naturalWidth : 612);
  }, [sourceKey, scrollViewKey]);

  usePreviewScrollMemory(scrollContainerRef, scrollViewKey);

  const zoom = usePdfZoom({
    containerRef: scrollContainerRef,
    source: sourceKey,
    viewKey: scrollViewKey,
    embedded: false,
    naturalWidth: naturalPageWidth,
    aspectRatio: pageAspectRatios.get(0) ?? DEFAULT_PDF_PAGE_ASPECT_RATIO,
  });
  const { pageWidth, renderedWidth, scaleFactor } = zoom;

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !numPages || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        const changes = entries.flatMap((entry) => {
          const pageIndex = Number(
            (entry.target as HTMLElement).dataset.pdfPageShell,
          );
          return Number.isInteger(pageIndex)
            ? [{ pageIndex, isVisible: entry.isIntersecting }]
            : [];
        });
        startTransition(() => {
          setVisiblePageIndexes((current) =>
            updateVisiblePdfPages(current, changes),
          );
          setRetainedPageIndexes((current) =>
            updateRetainedPdfPages(current, changes),
          );
        });
      },
      { root, rootMargin: '100% 0px' },
    );
    root
      .querySelectorAll<HTMLElement>('[data-pdf-page-shell]')
      .forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [numPages]);

  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    setLoadedPdf(null);
    setErrorState(null);
    setProgress(null);
    setPending(true);

    void loadDevicePdfBytes(agentletId, path, {
      signal: abort.signal,
      maxBytes: MAX_DEVICE_PDF_BYTES,
      onProgress: (loadedBytes, totalBytes) => {
        if (current !== generation.current) return;
        setProgress({ loadedBytes, totalBytes });
      },
    })
      .then((value) => {
        if (current !== generation.current || abort.signal.aborted) return;
        const blob = new Blob([value.bytes], { type: 'application/pdf' });
        setLoadedPdf({
          identity: fileIdentity,
          blob,
          contentVersion: value.contentVersion,
          size: value.size,
        });
      })
      .catch((failure: unknown) => {
        if (current !== generation.current || abort.signal.aborted) return;
        if (failure instanceof DevicePdfLoadError) {
          setErrorState({
            identity: fileIdentity,
            kind: failure.kind,
            detail: failure.message,
          });
          return;
        }
        setErrorState({
          identity: fileIdentity,
          kind: 'failed',
          detail: failure instanceof Error ? failure.message : undefined,
        });
      })
      .finally(() => {
        if (current === generation.current) {
          setPending(false);
          setProgress(null);
        }
      });

    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [agentletId, fileIdentity, path, refresh]);

  const handleAspectRatioResolved = useCallback(
    (pageIndex: number, aspectRatio: number, resolvedNaturalWidth?: number) => {
      if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
      if (
        pageIndex === 0 &&
        resolvedNaturalWidth &&
        resolvedNaturalWidth > 0 &&
        Math.abs(resolvedNaturalWidth - naturalPageWidth) > 0.5
      ) {
        setNaturalPageWidth(resolvedNaturalWidth);
      }
      setPageAspectRatios((current) => {
        const previous = current.get(pageIndex);
        if (
          previous !== undefined &&
          Math.abs(previous - aspectRatio) < 0.001
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(pageIndex, aspectRatio);
        return next;
      });
    },
    [naturalPageWidth],
  );

  const handlePassword = useCallback(() => {
    setErrorState({ identity: fileIdentity, kind: 'encrypted' });
  }, [fileIdentity]);

  const handleDocumentError = useCallback(
    (error?: Error) => {
      const isPasswordError =
        error?.name === 'PasswordException' ||
        /password/i.test(error?.message ?? '');
      setErrorState({
        identity: fileIdentity,
        kind: isPasswordError ? 'encrypted' : 'invalid_pdf',
        detail: error?.message,
      });
    },
    [fileIdentity],
  );

  const errorMessage = useMemo(() => {
    if (!activeError) return null;
    const limitMiB = Math.round(MAX_DEVICE_PDF_BYTES / 1_048_576);
    switch (activeError.kind) {
      case 'offline':
        return t('files.offline');
      case 'proxy_incompatible':
        return t('files.pdfProxyIncompatible');
      case 'not_found':
        return t('files.pdfNotFound');
      case 'permission_denied':
        return t('files.pdfPermissionDenied');
      case 'too_large':
        return t('files.pdfTooLarge', { limitMiB });
      case 'changed':
        return t('files.changed');
      case 'encrypted':
        return t('files.pdfEncrypted');
      case 'invalid_pdf':
        return t('files.pdfInvalid');
      case 'failed':
        return activeError.detail || t('files.failed');
    }
  }, [activeError, t]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-edge-default flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
        <span className="text-fg-muted min-w-0 flex-1 break-all">
          {reference.deviceName ?? agentletId} · {path}
        </span>
        {docLoaded && numPages ? (
          <span className="text-fg-subtle shrink-0 tabular-nums">
            {t('files.pdfPageCount', { count: numPages })}
          </span>
        ) : null}
        <PDFZoomControls
          zoom={zoom}
          disabled={!docLoaded || Boolean(errorMessage)}
        />
        {id || !canWrite || !canvasId ? null : (
          // Opened straight from the file browser: nothing is in the Space yet.
          // Adding a reference hands this Preview over to the new fileReference node.
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              try {
                openFileReference(
                  canvasId,
                  reference,
                  deviceFileName(reference.path),
                );
                closePreviewFile(reference);
              } catch (failure) {
                setErrorState({
                  identity: fileIdentity,
                  kind: 'failed',
                  detail:
                    failure instanceof Error
                      ? failure.message
                      : t('files.creationFailed'),
                });
              }
            }}
          >
            {t('files.addToSpace')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t('files.refresh')}
        </Button>
      </div>
      {errorMessage ? (
        <div role="alert" className="text-danger p-3 text-xs">
          {errorMessage}
        </div>
      ) : null}
      {pending ? (
        <div role="status" className="text-fg-muted p-2 text-xs">
          {progress && progress.totalBytes > 0
            ? t('files.pdfLoadingProgress', {
                loaded: formatByteSize(progress.loadedBytes),
                total: formatByteSize(progress.totalBytes),
              })
            : t('files.loading')}
        </div>
      ) : null}
      <div
        ref={scrollContainerRef}
        data-pdf-scroll-viewport
        aria-label={t('files.readOnlyPdf')}
        className="bg-surface relative min-h-0 flex-1 overflow-x-auto overflow-y-auto p-2"
      >
        {activePdf && !errorMessage ? (
          <>
            {!docLoaded ? (
              <Loading layout="overlay" variant="skeleton" />
            ) : null}
            <div
              className="mx-auto shrink-0"
              style={{
                width: pageWidth > 0 ? pageWidth : undefined,
                minWidth: '100%',
              }}
            >
              <Document
                key={sourceKey}
                file={activePdf.blob}
                options={PDF_DOCUMENT_OPTIONS}
                onLoadSuccess={onDocumentLoadSuccess}
                onPassword={handlePassword}
                onLoadError={handleDocumentError}
                onSourceError={handleDocumentError}
                loading=""
                error=""
                className="flex flex-col items-center gap-2"
              >
                {Array.from({ length: numPages ?? 0 }, (_unused, index) => (
                  <div
                    key={`page_${index + 1}`}
                    data-pdf-page-shell={index}
                    className="bg-bg-default shrink-0"
                    style={{
                      width: pageWidth > 0 ? pageWidth : '100%',
                      aspectRatio:
                        pageAspectRatios.get(index) ??
                        pageAspectRatios.get(0) ??
                        DEFAULT_PDF_PAGE_ASPECT_RATIO,
                    }}
                  >
                    {visiblePageIndexes.has(index) ||
                    retainedPageIndexes.has(index) ? (
                      <div
                        style={{
                          width: renderedWidth > 0 ? renderedWidth : undefined,
                          transformOrigin: 'top left',
                          transform: `scale(${scaleFactor})`,
                        }}
                      >
                        <PDFPageWithOverlay
                          pageNumber={index + 1}
                          pageIndex={index}
                          pageWidth={
                            renderedWidth > 0 ? renderedWidth : undefined
                          }
                          selectionScale={scaleFactor}
                          onAspectRatioResolved={handleAspectRatioResolved}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </Document>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
export default DevicePdfPreview;
