// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { autoHeightKey } from '@huabu/shared/canvas-engine';

import { measureNoteHeightOffscreen } from '@/components/Nodes/shared/height/measure/offscreenMeasurer';

import { measureMissingAutoHeights } from './measureMissingAutoHeights';

import type { Node } from '@xyflow/react';

vi.mock('@/components/Nodes/shared/height/measure/offscreenMeasurer', () => ({
  measureNoteHeightOffscreen: vi.fn(),
}));
const measure = vi.mocked(measureNoteHeightOffscreen);
const note = (width = 400): Node => ({
  id: 'n1',
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width, height: 300 },
  data: { content: '# hello', heightMode: 'fixed' },
});

beforeEach(() => measure.mockReset());

describe('auto toggle measurement', () => {
  it('remeasures a width-stale hint at actual width, while current hints skip work', async () => {
    const original = note();
    original.data.autoHeight = {
      intrinsicHeight: 200,
      measuredFor: autoHeightKey(original),
    };
    const state = { canvasId: 'c1', nodes: [original] };
    expect(await measureMissingAutoHeights(['n1'], () => state)).toEqual([]);
    expect(measure).not.toHaveBeenCalled();
    state.nodes = [{ ...original, style: { width: 800, height: 300 } }];
    measure.mockResolvedValue({ height: 120, provisional: false });
    expect(await measureMissingAutoHeights(['n1'], () => state)).toEqual([
      {
        nodeId: 'n1',
        intrinsicHeight: 120,
        measuredFor: autoHeightKey(state.nodes[0]),
      },
    ]);
    expect(measure).toHaveBeenCalledWith({
      markdown: '# hello',
      contentWidth: 794,
      canvasId: 'c1',
    });
  });

  it.each(['width', 'content', 'canvas', 'deleted'] as const)(
    'rejects in-flight results after %s changes',
    async (change) => {
      const state = { canvasId: 'c1', nodes: [note()] };
      measure.mockImplementation(async () => {
        if (change === 'width') state.nodes = [note(800)];
        if (change === 'content')
          state.nodes = [
            { ...note(), data: { content: 'changed', heightMode: 'fixed' } },
          ];
        if (change === 'canvas') state.canvasId = 'c2';
        if (change === 'deleted') state.nodes = [];
        return { height: 100, provisional: false };
      });
      expect(await measureMissingAutoHeights(['n1'], () => state)).toEqual([]);
    },
  );
});
