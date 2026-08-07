// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { HEIGHT_LAYOUT_VERSION } from '@huabu/shared/canvas-engine';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { normalizeNodeHeights } from '../normalizeNodeHeights';

import type { Node } from '@xyflow/react';

const CONTENT = '# hello';
const KEY = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content: CONTENT })}`;

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
    // 260 content, scaled by 394/400, plus 6px shell chrome, quantized.
    expect((result.style as { height?: number }).height).toBe(264);
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
