// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useState } from 'react';

import type { PdfIndexDocument } from './usePdfTextIndex';

export function usePdfDocumentLifecycle(source: string) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [document, setDocument] = useState<PdfIndexDocument | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
    setNumPages(null);
    setDocument(null);
  }, [source]);

  useEffect(() => {
    return () => {
      // React Activity preserves state but react-pdf destroys its document
      // proxy while the tab is hidden. Discard that stale proxy before the
      // effects restart so Page and the text index wait for a fresh load.
      setIsLoaded(false);
      setNumPages(null);
      setDocument(null);
    };
  }, []);

  const handleLoadSuccess = useCallback((nextDocument: PdfIndexDocument) => {
    setDocument(nextDocument);
    setNumPages(nextDocument.numPages);
    setIsLoaded(true);
  }, []);

  return { document, numPages, isLoaded, handleLoadSuccess };
}
