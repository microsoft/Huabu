// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import { getNodeFontFit, refitFont } from '../fontFit';

import type { Node } from '@xyflow/react';

function fontFit(node: Node) {
  const fit = getNodeFontFit(node);
  if (!fit) throw new Error('Expected a scalable node');
  return fit;
}

function textNode(accent: string | null): Node {
  return {
    id: 'text',
    type: 'text',
    position: { x: 0, y: 0 },
    style: { width: 200 },
    data: { content: 'Frame Test', style: { accent } },
  };
}

describe('getNodeFontFit', () => {
  it('captures the effective default font and canonical outer width', () => {
    expect(getNodeFontFit(textNode(null))).toEqual({
      fontSize: 16,
      width: 200,
    });
    expect(getNodeFontFit({ ...textNode(null), type: 'question' })).toEqual({
      fontSize: QUESTION_NODE_DEFAULT_FONT_SIZE,
      width: 200,
    });
  });

  it('uses measured width before authored width, including CSS-length fallback', () => {
    const node = { ...textNode(null), style: { width: '240px' } };
    expect(getNodeFontFit(node)?.width).toBe(240);
    expect(getNodeFontFit({ ...node, measured: { width: 250 } })?.width).toBe(
      250,
    );
  });

  it.each(['text', 'question'])(
    'preserves finite positive %s fonts',
    (type) => {
      const node = {
        ...textNode(null),
        type,
        data: { style: { fontSize: 17.375 } },
      };
      expect(getNodeFontFit(node)?.fontSize).toBe(17.375);
    },
  );

  it.each([undefined, null, 0, -1, NaN, Infinity, '30'])(
    'falls back for invalid stored font %s',
    (fontSize) => {
      const node = { ...textNode(null), data: { style: { fontSize } } };
      expect(getNodeFontFit(node)?.fontSize).toBe(16);
      expect(getNodeFontFit({ ...node, type: 'question' })?.fontSize).toBe(
        QUESTION_NODE_DEFAULT_FONT_SIZE,
      );
    },
  );

  it.each(['note', 'image', 'video', 'frame', 'web'])(
    'does not scale %s typography',
    (type) => {
      expect(getNodeFontFit({ ...textNode(null), type })).toBeNull();
    },
  );

  it('derives the same font whether or not the node has an accent', () => {
    const plain = fontFit(textNode(null));
    const accented = fontFit(textNode('blue'));

    expect(accented).toEqual(plain);
    expect(refitFont(accented, 200, 120)).toBe(refitFont(plain, 200, 120));
  });
});

describe('refitFont proportional scaling', () => {
  it.each(['text', 'question'])(
    'scales %s without rounding, measuring text, or using height',
    (type) => {
      const fit = fontFit({
        ...textNode(null),
        type,
        data: { content: '', style: { fontSize: 17.375 } },
      });
      const expected = (17.375 * 271) / 200;
      expect(refitFont(fit, 271, 1)).toBe(expected);
      expect(refitFont(fit, 271, 900)).toBe(expected);
      expect(refitFont(fit, 100, 900)).toBe(17.375 / 2);
      expect(refitFont(fit, 200, 900)).toBe(17.375);
    },
  );

  it.each([0, -1, NaN, Infinity])(
    'preserves the font for invalid width %s',
    (width) => {
      expect(refitFont({ fontSize: 16, width }, 200, 100)).toBe(16);
      expect(refitFont({ fontSize: 16, width: 200 }, width, 100)).toBe(16);
    },
  );

  it('preserves an unmeasured node font and avoids overflow', () => {
    const fit = fontFit({ ...textNode(null), style: {} });
    expect(fit.width).toBe(0);
    expect(refitFont(fit, 400, 100)).toBe(16);
    expect(refitFont({ fontSize: 16, width: 1 }, Number.MAX_VALUE, 100)).toBe(
      16,
    );
  });
});
