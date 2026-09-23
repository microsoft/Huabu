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
  it.each(['accepted', 'clear', 'stale', 'wrong-cover-source'] as const)(
    'handles video cover response: %s',
    async (scenario) => {
      const node: Node = {
        id: 'v',
        type: 'video',
        position: { x: 0, y: 0 },
        data: { src: 'movie.mp4' },
      };
      const patchNodeSilent = vi.fn();
      preprocessNode.mockResolvedValue({
        success: true,
        coverUrl: scenario === 'clear' ? null : 'cover.jpg',
        coverSourceSrc:
          scenario === 'clear'
            ? null
            : scenario === 'wrong-cover-source'
              ? 'wrong.mp4'
              : 'movie.mp4',
      });
      await preprocessNodeIfNeeded({
        canvasId: 'c',
        node,
        getNode: () =>
          scenario === 'stale' ? { ...node, data: { src: 'new.mp4' } } : node,
        patchNodeSilent,
        setNodeIngestion: vi.fn(),
        clearNodeIngestion: vi.fn(),
        getChildNodes: () => [],
      });
      if (scenario === 'accepted')
        expect(patchNodeSilent).toHaveBeenCalledWith('v', {
          coverUrl: 'cover.jpg',
          coverSourceSrc: 'movie.mp4',
        });
      else if (scenario === 'clear')
        expect(patchNodeSilent).toHaveBeenCalledWith('v', {
          coverUrl: undefined,
          coverSourceSrc: undefined,
        });
      else expect(patchNodeSilent).not.toHaveBeenCalled();
    },
  );

  it('adopts canonical artifact src and its matching video cover together', async () => {
    const node: Node = {
      id: 'v',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { src: '/api/canvas/c/artifact/movie.mp4' },
    };
    preprocessNode.mockResolvedValue({
      success: true,
      src: 'movie.mp4',
      coverUrl: 'cover.jpg',
      coverSourceSrc: 'movie.mp4',
    });
    const patchNodeSilent = vi.fn();
    await preprocessNodeIfNeeded({
      canvasId: 'c',
      node,
      getNode: () => node,
      patchNodeSilent,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      getChildNodes: () => [],
    });
    expect(patchNodeSilent).toHaveBeenCalledWith('v', {
      src: 'movie.mp4',
      coverUrl: 'cover.jpg',
      coverSourceSrc: 'movie.mp4',
    });
  });

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
