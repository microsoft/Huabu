// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPreprocessSnapshot, preprocessNodeIfNeeded } from './preprocess';

import type { Node } from '@xyflow/react';

const { preprocessNode } = vi.hoisted(() => ({
  preprocessNode: vi.fn(),
}));

vi.mock('@/api/canvas', () => ({ preprocessNode }));

beforeEach(() => {
  preprocessNode.mockReset();
});

describe('buildPreprocessSnapshot', () => {
  it('includes the current frame label so user-owned frame names stay protected', () => {
    const frame: Node = {
      id: 'frame-1',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Research Plan', labelSource: 'user' },
    };
    const child: Node = {
      id: 'note-1',
      type: 'note',
      parentId: frame.id,
      position: { x: 10, y: 10 },
      data: { label: 'Background' },
    };

    expect(buildPreprocessSnapshot(frame, () => [child])).toEqual({
      title: 'Research Plan',
      childLabels: ['Background'],
      labelSource: 'user',
    });
  });
});

describe('preprocessNodeIfNeeded', () => {
  it('does not overwrite a user label that was committed while preprocessing', async () => {
    const originalFrame: Node = {
      id: 'frame-1',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Frame', labelSource: 'auto' },
    };
    let currentFrame = originalFrame;
    let resolvePreprocess:
      | ((result: {
          suggestedLabel: string;
          summary: string;
          success: boolean;
        }) => void)
      | undefined;
    preprocessNode.mockReturnValue(
      new Promise((resolve) => {
        resolvePreprocess = resolve;
      }),
    );
    const patchNodeSilent = vi.fn();

    const pending = preprocessNodeIfNeeded({
      canvasId: 'canvas-1',
      node: originalFrame,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      getChildNodes: () => [],
      getNode: () => currentFrame,
      patchNodeSilent,
    });

    currentFrame = {
      ...originalFrame,
      data: { label: 'My Research', labelSource: 'user' },
    };
    resolvePreprocess?.({
      suggestedLabel: 'AI Research',
      summary: 'Current research topics',
      success: true,
    });
    await pending;

    expect(patchNodeSilent).toHaveBeenCalledWith('frame-1', {
      summary: 'Current research topics',
    });
  });
});
