// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { startTransition, useEffect, useRef, useState } from 'react';

import { textFromPdfItems, type PdfPageText } from './pdfTextIndex';

const TEXT_EXTRACTION_CONCURRENCY = 2;

export type PdfIndexDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items: unknown[] }>;
    getViewport: (options: { scale: number }) => {
      width: number;
      height: number;
    };
  }>;
};

type UsePdfTextIndexOptions = {
  document: PdfIndexDocument | null;
  enabled: boolean;
  onPageAspectRatio?: (pageIndex: number, aspectRatio: number) => void;
};

type PdfTextIndexSnapshot = {
  pages: ReadonlyMap<number, PdfPageText>;
  isIndexing: boolean;
  indexedPageCount: number;
};

export function usePdfTextIndex({
  document,
  enabled,
  onPageAspectRatio,
}: UsePdfTextIndexOptions): PdfTextIndexSnapshot {
  const [pages, setPages] = useState<ReadonlyMap<number, PdfPageText>>(
    () => new Map(),
  );
  const [processedPageCount, setProcessedPageCount] = useState(0);
  const processedPageIndexesRef = useRef(new Set<number>());

  useEffect(() => {
    processedPageIndexesRef.current = new Set();
    setPages(new Map());
    setProcessedPageCount(0);
  }, [document]);

  useEffect(() => {
    if (!document || !enabled) return;

    let cancelled = false;
    let nextPageNumber = 1;
    const worker = async (): Promise<void> => {
      while (!cancelled) {
        const pageNumber = nextPageNumber;
        nextPageNumber += 1;
        if (pageNumber > document.numPages) return;
        const pageIndex = pageNumber - 1;
        if (processedPageIndexesRef.current.has(pageIndex)) continue;

        try {
          const page = await document.getPage(pageNumber);
          const [textContent, viewport] = await Promise.all([
            page.getTextContent(),
            Promise.resolve(page.getViewport({ scale: 1 })),
          ]);
          if (cancelled) return;
          const text = textFromPdfItems(
            textContent.items as Array<{ str?: string; hasEOL?: boolean }>,
          );
          onPageAspectRatio?.(pageIndex, viewport.width / viewport.height);
          startTransition(() => {
            setPages((current) => {
              const next = new Map(current);
              next.set(pageIndex, { pageIndex, text });
              return next;
            });
          });
        } catch {
          // One malformed page must not prevent the remaining document from
          // becoming searchable.
        } finally {
          if (!cancelled) {
            processedPageIndexesRef.current.add(pageIndex);
            setProcessedPageCount(processedPageIndexesRef.current.size);
          }
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(TEXT_EXTRACTION_CONCURRENCY, document.numPages) },
      () => worker(),
    );
    void Promise.allSettled(workers);
    return () => {
      cancelled = true;
    };
  }, [document, enabled, onPageAspectRatio]);

  return {
    pages,
    isIndexing: !!document && enabled && processedPageCount < document.numPages,
    indexedPageCount: processedPageCount,
  };
}
