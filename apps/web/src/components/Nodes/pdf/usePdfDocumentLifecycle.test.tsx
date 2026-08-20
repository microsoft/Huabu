// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, Activity, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePdfDocumentLifecycle } from './usePdfDocumentLifecycle';

import type { PdfIndexDocument } from './usePdfTextIndex';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness({
  onDocumentEffect,
}: {
  onDocumentEffect: (document: PdfIndexDocument | null) => void;
}) {
  const { document, handleLoadSuccess } = usePdfDocumentLifecycle('test.pdf');

  useEffect(() => {
    onDocumentEffect(document);
  }, [document, onDocumentEffect]);

  return (
    <button
      type="button"
      onClick={() => handleLoadSuccess({ numPages: 1, getPage: vi.fn() })}
    >
      Load
    </button>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('usePdfDocumentLifecycle', () => {
  it('discards a destroyed proxy before Activity effects restart', async () => {
    const observedDocuments: Array<PdfIndexDocument | null> = [];
    const onDocumentEffect = (document: PdfIndexDocument | null) => {
      observedDocuments.push(document);
    };
    const render = (mode: 'visible' | 'hidden') => {
      root.render(
        <Activity mode={mode}>
          <Harness onDocumentEffect={onDocumentEffect} />
        </Activity>,
      );
    };

    await act(async () => render('visible'));
    act(() => container.querySelector('button')?.click());
    expect(observedDocuments.at(-1)).not.toBeNull();

    await act(async () => render('hidden'));
    observedDocuments.length = 0;
    await act(async () => render('visible'));

    expect(observedDocuments).toEqual([null]);
  });
});
