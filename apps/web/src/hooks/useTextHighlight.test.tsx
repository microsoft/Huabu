// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { findProjectedRange } from './searchDom';
import { useTextHighlight } from './useTextHighlight';

let root: Root;
let host: HTMLDivElement;
let canvas: HTMLDivElement;
let preview: HTMLDivElement;
let highlights: Map<string, Set<Range>>;

function Surface({
  element,
  query,
  activeMatchIndex,
  getActiveRange,
}: {
  element: HTMLElement | null;
  query: string;
  activeMatchIndex?: number;
  getActiveRange?: () => Range | null;
}) {
  const { matchCount } = useTextHighlight({
    container: element,
    query,
    activeMatchIndex,
    getActiveRange,
  });
  return <output>{matchCount}</output>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  highlights = new Map();
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal('CSS', { highlights });
  host = document.createElement('div');
  canvas = document.createElement('div');
  preview = document.createElement('div');
  canvas.textContent = 'canvas needle';
  preview.textContent = 'preview needle';
  document.body.append(host, canvas, preview);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  canvas.remove();
  preview.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('refreshes an indexed phrase highlight when its text-layer nodes are replaced', async () => {
  preview.innerHTML = '<span>needle</span><span>phrase</span>';
  const getActiveRange = () =>
    findProjectedRange(preview, 'needle phrase', 0, 13);
  act(() =>
    root.render(
      <Surface
        element={preview}
        query="needle phrase"
        getActiveRange={getActiveRange}
      />,
    ),
  );
  expect(highlights.get('huabu-search')?.size).toBe(1);
  const previousRange = Array.from(highlights.get('huabu-search') ?? [])[0];
  preview.innerHTML = '<span>needle</span><span>phrase</span>';
  await act(async () => {
    await vi.waitFor(() => {
      const range = Array.from(highlights.get('huabu-search') ?? [])[0];
      expect(range).not.toBe(previousRange);
      expect(range?.startContainer).toBe(preview.firstElementChild?.firstChild);
      expect(range?.toString()).toBe('needlephrase');
    });
  });
  expect(highlights.get('huabu-search')?.size).toBe(1);
});

it('merges independent canvas and preview highlights and removes only the closing surface', () => {
  act(() =>
    root.render(
      <>
        <Surface element={canvas} query="needle" />
        <Surface element={preview} query="needle" />
        <Surface element={null} query="" />
      </>,
    ),
  );
  expect(highlights.get('huabu-search')?.size).toBe(2);
  act(() =>
    root.render(
      <>
        <Surface element={canvas} query="needle" />
        <Surface element={null} query="" />
      </>,
    ),
  );
  expect(highlights.get('huabu-search')?.size).toBe(1);
  expect(
    Array.from(highlights.get('huabu-search') ?? [])[0]?.startContainer,
  ).toBe(canvas.firstChild);
  act(() => root.render(<Surface element={null} query="" />));
  expect(highlights.has('huabu-search')).toBe(false);
});

it('counts all matches while allocating only the bounded painted ranges', async () => {
  canvas.textContent = 'needle '.repeat(600);
  const createRange = vi.spyOn(document, 'createRange');
  act(() => root.render(<Surface element={canvas} query="needle" />));
  expect(host.textContent).toBe('600');
  expect(highlights.get('huabu-search')?.size).toBe(500);
  expect(createRange).toHaveBeenCalledTimes(500);
  canvas.textContent += 'needle';
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });

    expect(host.textContent).toBe('601');
  });
  expect(highlights.get('huabu-search')?.size).toBe(500);
});

it('keeps an occurrence beyond the cap highlighted without increasing the painted range count', () => {
  canvas.textContent = 'needle '.repeat(600);
  const createRange = vi.spyOn(document, 'createRange');
  act(() =>
    root.render(
      <Surface element={canvas} query="needle" activeMatchIndex={500} />,
    ),
  );
  expect(host.textContent).toBe('600');
  expect(highlights.get('huabu-search')?.size).toBe(500);
  expect(createRange).toHaveBeenCalledTimes(501);
  expect(
    Array.from(highlights.get('huabu-search') ?? []).at(-1)?.startOffset,
  ).toBe(3500);
  act(() =>
    root.render(
      <Surface element={canvas} query="needle" activeMatchIndex={501} />,
    ),
  );
  expect(highlights.get('huabu-search')?.size).toBe(500);
  expect(
    Array.from(highlights.get('huabu-search') ?? []).at(-1)?.startOffset,
  ).toBe(3507);
});
