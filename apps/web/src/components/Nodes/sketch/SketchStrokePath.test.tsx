// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SketchStrokePath } from './SketchStrokePath';

import type { SketchStroke } from '@huabu/shared';

const stroke: SketchStroke = {
  id: 'stroke-1',
  points: [
    [0, 0, 0.5],
    [20, 10, 0.5],
    [40, 0, 0.5],
  ],
  color: 'black',
  size: 8,
  createdAt: 1,
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('SketchStrokePath', () => {
  it('paints a screen-stable semantic outline behind selected Ink', () => {
    act(() =>
      root?.render(
        <svg>
          <SketchStrokePath
            stroke={stroke}
            scaleX={1}
            scaleY={1}
            emphasis="selected"
          />
        </svg>,
      ),
    );

    const paths = host?.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    expect(paths?.[0]?.getAttribute('data-sketch-stroke-emphasis')).toBe(
      'selected',
    );
    expect(paths?.[0]?.hasAttribute('data-canvas-grounding-exclude')).toBe(
      true,
    );
    expect(paths?.[0]?.getAttribute('stroke')).toBe('var(--color-info)');
    expect(paths?.[0]?.getAttribute('stroke-width')).toBe('2');
    expect(paths?.[0]?.getAttribute('stroke-opacity')).toBe('0.7');
    expect(paths?.[0]?.style.filter).toBe(
      'drop-shadow(0 0 2px var(--color-info-light))',
    );
    expect(paths?.[0]?.getAttribute('vector-effect')).toBe(
      'non-scaling-stroke',
    );
    expect(paths?.[1]?.getAttribute('fill')).toBe('black');
  });
});
