import { describe, expect, it } from 'vitest';

import { getSketchRenderedSize } from '../utils/nodeSizes.js';

import type { Node } from '@xyflow/react';

describe('getSketchRenderedSize', () => {
  it('prefers authored style dimensions over stale measured dimensions', () => {
    const node = {
      id: 'sketch-1',
      type: 'sketch',
      position: { x: 0, y: 0 },
      data: { initialSize: { width: 80, height: 40 } },
      style: { width: 100.25, height: 50.5 },
      measured: { width: 100, height: 50 },
    } as Node;

    expect(getSketchRenderedSize(node)).toEqual({
      width: 100.25,
      height: 50.5,
    });
  });

  it('falls back to measured dimensions when no authored size exists', () => {
    const node = {
      id: 'sketch-1',
      type: 'sketch',
      position: { x: 0, y: 0 },
      data: { initialSize: { width: 80, height: 40 } },
      measured: { width: 100, height: 50 },
    } as Node;

    expect(getSketchRenderedSize(node)).toEqual({ width: 100, height: 50 });
  });
});
