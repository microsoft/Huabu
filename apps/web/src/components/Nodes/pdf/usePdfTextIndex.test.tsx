// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { usePdfTextIndex, type PdfIndexDocument } from './usePdfTextIndex';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('publishes readiness atomically with every extracted page and hides a replaced index', async () => {
  const snapshots: Array<{
    searching: boolean;
    pages: number;
    processed: number;
  }> = [];
  function Harness({ pdf }: { pdf: PdfIndexDocument | null }) {
    const index = usePdfTextIndex({ document: pdf, enabled: true });
    snapshots.push({
      searching: index.isIndexing,
      pages: index.pages.size,
      processed: index.indexedPageCount,
    });
    return null;
  }
  const pdf: PdfIndexDocument = {
    numPages: 4,
    getPage: vi.fn(async () => ({
      getTextContent: async () => ({ items: [{ str: 'needle' }] }),
      getViewport: () => ({ width: 612, height: 792 }),
    })),
  };
  await act(async () => root.render(<Harness pdf={pdf} />));
  expect(snapshots.at(-1)).toEqual({
    searching: false,
    pages: 4,
    processed: 4,
  });
  expect(
    snapshots
      .filter((snapshot) => !snapshot.searching)
      .every((snapshot) => snapshot.pages === 4 && snapshot.processed === 4),
  ).toBe(true);
  snapshots.length = 0;
  act(() => root.render(<Harness pdf={null} />));
  expect(snapshots.every((snapshot) => snapshot.pages === 0)).toBe(true);
});
