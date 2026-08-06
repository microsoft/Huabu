// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The frame-resize cascade must derive a child's font from the SAME
 * insets the node renders and measures with. It used to add the node
 * shell's border when an accent was set, which measured the text
 * narrower than it lays out — the node then reserved a line that
 * rendered empty. Accent is a colour decision and must not move geometry.
 */

import { describe, expect, it } from 'vitest';

import { getNodeFontFit, refitFont } from '../fontFit';
import {
  QUESTION_NODE_PADDING,
  TEXT_NODE_PADDING_X,
  TEXT_NODE_PADDING_Y,
} from '../nodeFontConfig';

import type { Node } from '@xyflow/react';

function textNode(accent: string | null): Node {
  return {
    id: 'text',
    type: 'text',
    position: { x: 0, y: 0 },
    data: { content: 'Frame Test', style: { accent } },
  };
}

describe('getNodeFontFit', () => {
  it('uses the body padding as the inset, with no border term', () => {
    expect(getNodeFontFit(textNode(null))).toMatchObject({
      insetX: TEXT_NODE_PADDING_X,
      insetY: TEXT_NODE_PADDING_Y,
    });
    expect(
      getNodeFontFit({ ...textNode(null), type: 'question' }),
    ).toMatchObject({
      insetX: QUESTION_NODE_PADDING,
      insetY: QUESTION_NODE_PADDING,
    });
  });

  it('derives the same font whether or not the node has an accent', () => {
    const plain = getNodeFontFit(textNode(null));
    const accented = getNodeFontFit(textNode('blue'));

    expect(accented).toEqual(plain);
    expect(refitFont(accented!, 200, 120)).toBe(refitFont(plain!, 200, 120));
  });
});
