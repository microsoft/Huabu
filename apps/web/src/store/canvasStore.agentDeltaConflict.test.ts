// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

function question(content: string, status: string): Node {
  return {
    id: 'question-1',
    type: 'question',
    position: { x: 0, y: 0 },
    data: { type: 'question', label: 'Question 1', content, status },
  };
}

const pendingEffects = {
  mutatedNodes: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

const provenance = {
  version: 1,
  blocks: [
    {
      key: 'block-1',
      kind: 'modified',
      baselineMarkdown: 'Original text',
      at: '2026-09-14T00:00:00.000Z',
    },
  ],
  deletedBlocks: [],
};

function roundTripReplacement(
  prevMetadata: Record<string, unknown>,
  nextMetadata: Record<string, unknown>,
): Delta {
  const prev = question('', 'idle');
  const next = question('', 'running');
  Object.assign(prev.data, prevMetadata);
  Object.assign(next.data, nextMetadata);
  // SSE transmits both nodes as JSON, so equal objects lose shared identity.
  return JSON.parse(JSON.stringify({ type: 'REPLACE_NODE', prev, next }));
}

beforeEach(() => {
  vi.useFakeTimers();
  canvasHistoryManager.activate('canvas-1', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    nodes: [question('', 'idle')],
    edges: [],
    version: 1,
    isLoading: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('agent delta conflict protection', () => {
  it('keeps first submitted intent out of undo and rebases earlier geometry snapshots', () => {
    const before = question('', 'idle');
    canvasHistoryManager.takeSnapshot([before], []);
    const moved = { ...before, position: { x: 30, y: 0 } };
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [moved] });
    const started = {
      ...moved,
      data: {
        ...moved.data,
        content: 'First intent',
        status: 'running',
        invocationToken: 'first',
      },
    };
    useCanvasStore
      .getState()
      .applyDeltasFromAgent(
        [{ type: 'REPLACE_NODE', prev: moved, next: started }],
        2,
        pendingEffects,
        true,
      );
    const undone = canvasHistoryManager.undo(
      useCanvasStore.getState().nodes,
      [],
    );
    expect(undone?.nodes[0]).toMatchObject({
      position: { x: 0, y: 0 },
      data: {
        content: 'First intent',
        status: 'running',
        invocationToken: 'first',
      },
    });
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('does not put FSM-only broadcasts into ordinary undo', () => {
    useCanvasStore.getState().applyDeltasFromAgent(
      [
        {
          type: 'REPLACE_NODE',
          prev: question('', 'idle'),
          next: {
            ...question('', 'running'),
            data: {
              ...question('', 'running').data,
              bindingState: 'bound',
              invocationToken: 'current',
            },
          },
        },
      ],
      2,
      pendingEffects,
    );
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
  it.each([
    {
      name: 'keywords',
      prevMetadata: { keywords: ['topic'] },
      nextMetadata: { keywords: ['topic'] },
    },
    {
      name: 'provenance',
      prevMetadata: { provenance },
      nextMetadata: { provenance },
    },
    {
      name: 'provenance with reordered object properties',
      prevMetadata: { provenance },
      nextMetadata: {
        provenance: {
          deletedBlocks: [],
          blocks: [
            {
              at: '2026-09-14T00:00:00.000Z',
              baselineMarkdown: 'Original text',
              kind: 'modified',
              key: 'block-1',
            },
          ],
          version: 1,
        },
      },
    },
  ])(
    'applies lifecycle changes with equal $name after JSON transport',
    ({ prevMetadata, nextMetadata }) => {
      const localPatch = {
        content: 'Pending prompt',
        keywords: ['local topic'],
        provenance: { version: 1, blocks: [], deletedBlocks: [] },
      };
      useCanvasStore.getState().patchNodeSilent('question-1', localPatch);

      const delta = roundTripReplacement(prevMetadata, nextMetadata);
      const skipped = useCanvasStore
        .getState()
        .applyDeltasFromAgent([delta], 2, pendingEffects);

      expect(skipped).toEqual([]);
      expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
        ...localPatch,
        status: 'running',
      });
      expect(useCanvasStore.getState().version).toBe(2);
      expect(useCanvasStore.getState().pendingContentNodeIds()).toContain(
        'question-1',
      );
    },
  );

  it.each([
    {
      name: 'changed keywords',
      prevMetadata: { keywords: ['topic'] },
      nextMetadata: { keywords: ['different topic'] },
    },
    {
      name: 'removed keywords',
      prevMetadata: { keywords: ['topic'] },
      nextMetadata: {},
    },
    {
      name: 'changed nested provenance',
      prevMetadata: { provenance },
      nextMetadata: {
        provenance: {
          ...provenance,
          blocks: [
            { ...provenance.blocks[0], baselineMarkdown: 'Different text' },
          ],
        },
      },
    },
    {
      name: 'removed provenance',
      prevMetadata: { provenance },
      nextMetadata: {},
    },
  ])(
    'still skips $name after JSON transport while local content is pending',
    ({ prevMetadata, nextMetadata }) => {
      useCanvasStore
        .getState()
        .patchNodeSilent('question-1', { content: 'Pending prompt' });
      const before = useCanvasStore.getState().nodes[0];

      const delta = roundTripReplacement(prevMetadata, nextMetadata);
      const skipped = useCanvasStore
        .getState()
        .applyDeltasFromAgent([delta], 2, pendingEffects);

      expect(skipped).toEqual(['question-1']);
      expect(useCanvasStore.getState().nodes[0]).toEqual({
        ...before,
        data: { ...before.data, status: 'running' },
      });
      expect(useCanvasStore.getState().version).toBe(2);
    },
  );

  it('applies lifecycle-only changes without overwriting pending local content', () => {
    useCanvasStore
      .getState()
      .patchNodeSilent('question-1', { content: 'Pending prompt' });

    const delta: Delta = {
      type: 'REPLACE_NODE',
      prev: question('', 'idle'),
      next: question('', 'running'),
    };
    const skipped = useCanvasStore
      .getState()
      .applyDeltasFromAgent([delta], 2, pendingEffects);

    expect(skipped).toEqual([]);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
      content: 'Pending prompt',
      status: 'running',
    });
    expect(useCanvasStore.getState().version).toBe(2);
  });

  it('still skips a remote content change while local content is pending', () => {
    useCanvasStore
      .getState()
      .patchNodeSilent('question-1', { content: 'Pending prompt' });

    const delta: Delta = {
      type: 'REPLACE_NODE',
      prev: question('', 'idle'),
      next: question('Remote prompt', 'running'),
    };
    const skipped = useCanvasStore
      .getState()
      .applyDeltasFromAgent([delta], 2, pendingEffects);

    expect(skipped).toEqual(['question-1']);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({
      content: 'Pending prompt',
      status: 'running',
    });

    expect(useCanvasStore.getState().version).toBe(2);
  });

  it('accepts mixed FSM metadata without replacing dirty content or local geometry', () => {
    useCanvasStore
      .getState()
      .patchNodeSilent('question-1', { content: 'Pending prompt' });
    const local = useCanvasStore.getState().nodes[0];
    const next = {
      ...question('Remote prompt', 'done'),
      position: { x: 500, y: 500 },
      data: {
        ...question('Remote prompt', 'done').data,
        bindingState: 'bound',
        invocationToken: 'invocation-new',
        viewed: false,
        threadId: 'thread-1',
      },
    };
    expect(
      useCanvasStore
        .getState()
        .applyDeltasFromAgent(
          [{ type: 'REPLACE_NODE', prev: question('', 'idle'), next }],
          2,
          pendingEffects,
        ),
    ).toEqual(['question-1']);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({
      position: local.position,
      data: {
        content: 'Pending prompt',
        status: 'done',
        bindingState: 'bound',
        invocationToken: 'invocation-new',
        viewed: false,
      },
    });
    expect(useCanvasStore.getState().pendingContentNodeIds()).toContain(
      'question-1',
    );
  });
});
