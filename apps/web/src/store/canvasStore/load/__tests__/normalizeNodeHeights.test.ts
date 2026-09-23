// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { autoHeightKey } from '@huabu/shared/canvas-engine';

import { normalizeNodeHeights } from '../normalizeNodeHeights';

import type { Node } from '@xyflow/react';

const CONTENT = '# hello';
const KEY = autoHeightKey(node());

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400 },
    data: { type: 'note', content: CONTENT },
    ...overrides,
  } as Node;
}

describe('normalizeNodeHeights', () => {
  it('keeps the persisted numeric seed for width-stale and legacy hints', () => {
    for (const measuredFor of [KEY, '10:legacy']) {
      const original = node({
        style: { width: 800, height: 321 },
        data: {
          content: CONTENT,
          heightMode: 'auto',
          autoHeight: { intrinsicHeight: 260, measuredFor },
        },
      });
      const [result] = normalizeNodeHeights([original]);
      expect(result.style?.height).toBe(321);
      expect(result.measured?.height).toBe(321);
      expect(result.data.autoHeight).toBe(original.data.autoHeight);
    }
  });

  it('infers auto from the legacy encoding — the absence of a height', () => {
    const [result] = normalizeNodeHeights([node()]);
    expect((result.data as { heightMode?: string }).heightMode).toBe('auto');
  });

  it('infers fixed from a persisted numeric height', () => {
    const [result] = normalizeNodeHeights([
      node({ style: { width: 400, height: 700 } }),
    ]);
    expect((result.data as { heightMode?: string }).heightMode).toBe('fixed');
    expect((result.style as { height?: number }).height).toBe(700);
  });

  it('gives an unmeasured auto note a positive height', () => {
    const [result] = normalizeNodeHeights([node()]);
    expect((result.style as { height?: number }).height).toBeGreaterThan(0);
  });

  it('materializes from a stored hint', () => {
    const [result] = normalizeNodeHeights([
      node({
        data: {
          type: 'note',
          content: CONTENT,
          autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
        },
      }),
    ]);
    // 260 content plus 6px shell chrome, quantized.
    expect((result.style as { height?: number }).height).toBe(268);
  });

  it('never fabricates a hint, not even from the legacy measured height', () => {
    const [result] = normalizeNodeHeights([
      node({ data: { type: 'note', content: CONTENT, measuredHeight: 640 } }),
    ]);
    expect(
      (result.data as { autoHeight?: unknown }).autoHeight,
    ).toBeUndefined();
  });

  it('leaves text and question nodes to their own sizing mechanism', () => {
    const text = node({ id: 't1', type: 'text', data: { type: 'text' } });
    const [result] = normalizeNodeHeights([text]);
    expect(result).toBe(text);
  });

  it('returns the same array reference when nothing changes', () => {
    const nodes = normalizeNodeHeights([node()]);
    expect(normalizeNodeHeights(nodes)).toBe(nodes);
  });
});
