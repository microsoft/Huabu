// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { computeHighlightUpdate } from '@/handler/pdfHighlight/highlight';

import { readPdfHighlightText, readPdfSelection } from './pdfSelection';

it.each([
  { chunks: ['micro', 'scope'], gap: 0, y: 0, expected: 'microscope' },
  { chunks: ['two', 'words'], gap: 5, y: 0, expected: 'two words' },
  { chunks: ['two  ', 'words'], gap: 0, y: 0, expected: 'two  words' },
  { chunks: ['two', '  ', 'words'], gap: 0, y: 0, expected: 'two  words' },
  { chunks: ['micro', 'scope'], gap: 1, y: 0, expected: 'microscope' },
  { chunks: ['中', '文'], gap: 0, y: 0, expected: '中文' },
  { chunks: ['first', 'second'], gap: 0, y: 20, expected: 'first\nsecond' },
])('recovers PDF glyph spacing: $expected', ({ chunks, gap, y, expected }) => {
  const page = document.createElement('div');
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  page.append(layer);
  document.body.append(page);
  const positions = new Map<Node, { x: number; y: number }>();
  let x = 10;
  chunks.forEach((text, index) => {
    const node = document.createTextNode(text);
    layer.append(node);
    positions.set(node, { x, y: 10 + (index ? y : 0) });
    x += text.length * 5 + gap;
  });
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 200, 100),
  );
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => {
      const position = positions.get(range.startContainer);
      if (!position) throw new Error('Missing glyph position');
      return new DOMRect(position.x + range.startOffset * 5, position.y, 5, 10);
    };
    return range;
  });
  expect(
    readPdfHighlightText(page, {
      id: 'highlight',
      pageIndex: 0,
      rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    }),
  ).toBe(expected);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('captures page-normalized geometry and exact selected text across pages', () => {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pdf-page-index="0">First</div><div data-pdf-page-index="1">Second</div>';
  document.body.append(root);
  const [first, second] = [...root.children] as HTMLElement[];
  if (!first?.firstChild || !second?.firstChild)
    throw new Error('Missing test page text');
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 100),
  );
  vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 100, 100, 100),
  );
  const range = document.createRange();
  range.setStart(first.firstChild, 0);
  range.setEnd(second.firstChild, 6);
  const selection = window.getSelection();
  if (!selection) throw new Error('Missing browser selection');
  selection.addRange(range);
  const rects = [new DOMRect(10, 10, 50, 10), new DOMRect(10, 110, 60, 10)];
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    Object.assign(rects, { item: (index: number) => rects[index] ?? null }),
  );
  const captured = readPdfSelection(root, selection);
  if (!captured) throw new Error('Expected PDF selection');
  expect(captured?.text).toBe('FirstSecond');
  expect([...captured.rects.keys()]).toEqual([0, 1]);
  expect(captured?.rects.get(1)).toEqual([
    { x: 0.1, y: 0.1, width: 0.6, height: 0.1 },
  ]);
  expect(captured?.position).toEqual({ x: 70, y: 120 });
  expect(captured?.selectionRect).toEqual(new DOMRect(10, 10, 60, 110));
});

it('rejects selections crossing out of the PDF', () => {
  const root = document.createElement('div');
  root.textContent = 'PDF';
  if (!root.firstChild) throw new Error('Missing test PDF text');
  const outside = document.createTextNode('Other');
  document.body.append(root, outside);
  const range = document.createRange();
  range.setStart(root.firstChild, 0);
  range.setEnd(outside, 2);
  const selection = window.getSelection();
  if (!selection) throw new Error('Missing browser selection');
  selection.addRange(range);
  expect(readPdfSelection(root, window.getSelection())).toBeNull();
});

it('explicit Highlight never toggles off already covered text', () => {
  const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.03 };
  const highlights = [{ id: 'existing', pageIndex: 0, rects: [rect] }];
  expect(
    computeHighlightUpdate(highlights, new Map([[0, [rect]]]), 'add'),
  ).toEqual(highlights);
  expect(
    computeHighlightUpdate(highlights, new Map([[0, [rect]]]), 'toggle'),
  ).toEqual([]);
});
