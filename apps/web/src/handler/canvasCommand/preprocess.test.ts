// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPreprocessSnapshot, preprocessNodeIfNeeded } from './preprocess';

import type { CanvasCommitEvent } from '@huabu/shared';
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

  it('routes a full commit without replaying legacy response patches', async () => {
    const node: Node = {
      id: 'frame-commit',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { label: 'Frame', labelSource: 'auto' },
    };
    const commit: CanvasCommitEvent = {
      commitId: 'preprocess-commit',
      fromVersion: 4,
      toVersion: 5,
      structureRevision: 'structure-stable',
      originator: { source: 'ui', tabId: 'tab-1' },
      optimistic: false,
      recordChanged: true,
      structureDeltas: [],
      nodeChanges: [
        {
          kind: 'inline',
          nodeId: node.id,
          recordRevision: 'record-2',
          projection: {
            type: 'frame',
            label: 'Server label',
            labelSource: 'auto',
            content: '',
            rev: 'node-rev-2',
            summary: 'Server summary',
          },
        },
      ],
    };
    preprocessNode.mockResolvedValueOnce({
      nodeId: node.id,
      success: true,
      commit,
      // These legacy mirrors must not produce a second client patch.
      suggestedLabel: 'Legacy label',
      summary: 'Legacy summary',
    });
    const patchNodeSilent = vi.fn();
    const onMutationResponse = vi.fn();

    await preprocessNodeIfNeeded({
      canvasId: 'canvas-1',
      node,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      getChildNodes: () => [],
      getNode: () => node,
      patchNodeSilent,
      onMutationResponse,
    });

    expect(onMutationResponse).toHaveBeenCalledWith(
      'canvas-1',
      expect.objectContaining({ commit }),
    );
    expect(patchNodeSilent).not.toHaveBeenCalled();
  });

  it('does not apply a legacy response after the target is deleted', async () => {
    const node: Node = {
      id: 'deleted-in-flight',
      type: 'office',
      position: { x: 0, y: 0 },
      data: { src: 'original.docx' },
    };
    let currentNode: Node | undefined = node;
    let resolvePreprocess:
      | ((result: {
          success: boolean;
          content: string;
          summary: string;
        }) => void)
      | undefined;
    preprocessNode.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreprocess = resolve;
      }),
    );
    const patchNodeSilent = vi.fn();
    const clearNodeIngestion = vi.fn();

    const pending = preprocessNodeIfNeeded({
      canvasId: 'canvas-1',
      node,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion,
      getChildNodes: () => [],
      getNode: () => currentNode,
      patchNodeSilent,
    });
    currentNode = undefined;
    resolvePreprocess?.({
      success: true,
      content: 'stale extraction',
      summary: 'stale summary',
    });
    await pending;

    expect(patchNodeSilent).not.toHaveBeenCalled();
    expect(clearNodeIngestion).toHaveBeenCalledWith(node.id);
  });

  it('does not apply a legacy response after the target changes type', async () => {
    const node: Node = {
      id: 'converted-in-flight',
      type: 'office',
      position: { x: 0, y: 0 },
      data: { src: 'original.docx' },
    };
    let currentNode: Node = node;
    let resolvePreprocess:
      | ((result: { success: boolean; content: string }) => void)
      | undefined;
    preprocessNode.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreprocess = resolve;
      }),
    );
    const patchNodeSilent = vi.fn();

    const pending = preprocessNodeIfNeeded({
      canvasId: 'canvas-1',
      node,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      getChildNodes: () => [],
      getNode: () => currentNode,
      patchNodeSilent,
    });
    currentNode = { ...node, type: 'pdf' };
    resolvePreprocess?.({ success: true, content: 'stale extraction' });
    await pending;

    expect(patchNodeSilent).not.toHaveBeenCalled();
  });

  it('does not apply a non-commit projection after the Space cursor advances', async () => {
    const node: Node = {
      id: 'same-type-aba',
      type: 'office',
      position: { x: 0, y: 0 },
      data: { src: 'original.docx' },
    };
    let version = 7;
    let resolvePreprocess:
      | ((result: {
          success: boolean;
          observedVersion: number;
          content: string;
        }) => void)
      | undefined;
    preprocessNode.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreprocess = resolve;
      }),
    );
    const patchNodeSilent = vi.fn();

    const pending = preprocessNodeIfNeeded({
      canvasId: 'canvas-1',
      node,
      setNodeIngestion: vi.fn(),
      clearNodeIngestion: vi.fn(),
      getChildNodes: () => [],
      getNode: () => node,
      getVersion: () => version,
      patchNodeSilent,
    });
    version = 8;
    resolvePreprocess?.({
      success: true,
      observedVersion: 7,
      content: 'stale extraction',
    });
    await pending;

    expect(patchNodeSilent).not.toHaveBeenCalled();
  });
});
