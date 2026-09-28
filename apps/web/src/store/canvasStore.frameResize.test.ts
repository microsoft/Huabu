// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyResizeProposal,
  beginSnapSession,
  endSnapSession,
} from '@/handler/snap/snapSession';

import useCanvasStore from './canvasStore';

import type { Node } from '@xyflow/react';

afterEach(() => {
  endSnapSession();
  useCanvasStore.getState()._setStateNoAutosave({ nodes: [], edges: [] });
});

describe('Frame resize React Flow measurement boundary', () => {
  it('does not publish rounded Frame measurements when authored dimensions are already recorded', () => {
    const frame: Node = {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: {},
      style: { width: 579.38, height: 722.34 },
      measured: { width: 579.38, height: 722.34 },
    };
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ nodes: [frame], edges: [] });
    const before = useCanvasStore.getState();
    before.onNodesChange([
      {
        type: 'dimensions',
        id: 'frame',
        dimensions: { width: 579, height: 722 },
      },
    ]);
    expect(useCanvasStore.getState()).toBe(before);
    before.onNodesChange([
      {
        type: 'dimensions',
        id: 'frame',
        dimensions: { width: 579, height: 722 },
        resizing: true,
      },
    ]);
    expect(useCanvasStore.getState().nodes[0].resizing).toBe(true);
    before.onNodesChange([
      {
        type: 'dimensions',
        id: 'frame',
        dimensions: { width: 579, height: 722 },
        resizing: false,
      },
    ]);
    expect(useCanvasStore.getState().nodes[0].resizing).toBe(false);
    expect(useCanvasStore.getState().nodes[0].measured).toEqual(frame.measured);
    const note: Node = {
      id: 'note',
      type: 'note',
      position: { x: 0, y: 0 },
      data: {},
    };
    before._setStateNoAutosave({ nodes: [frame, note], edges: [] });
    before.onNodesChange([
      {
        type: 'dimensions',
        id: 'frame',
        dimensions: { width: 579, height: 722 },
      },
      {
        type: 'dimensions',
        id: 'note',
        dimensions: { width: 400, height: 200 },
      },
    ]);
    expect(useCanvasStore.getState().nodes[0]).toBe(frame);
    expect(useCanvasStore.getState().nodes[1].measured).toEqual({
      width: 400,
      height: 200,
    });
  });

  it('leaves Text and Question height renderer-owned during width resize', () => {
    const nodes: Node[] = ['text', 'question'].map((type) => ({
      id: type,
      type,
      position: { x: 20, y: 20 },
      data: {},
      style: { width: 360, height: 240 },
      measured: { width: 360, height: 240 },
    }));
    useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [] });
    beginSnapSession({
      nodes,
      gestureIds: new Set(['question']),
      altPressed: true,
      kind: 'resize',
      resizeContext: {
        nodeId: 'question',
        startRect: { x: 20, y: 20, w: 360, h: 240 },
        startLocalPos: { x: 20, y: 20 },
        parentOffset: { x: 0, y: 0 },
        mode: 'width',
        lockAspect: false,
      },
    });
    applyResizeProposal({ x: 20, y: 20, width: 180, height: 240 }, 1);
    useCanvasStore.getState().onNodesChange([
      {
        type: 'dimensions',
        id: 'question',
        dimensions: { width: 180, height: 240 },
        resizing: true,
      },
    ]);

    const question = useCanvasStore
      .getState()
      .nodes.find((candidate) => candidate.id === 'question');
    expect(question?.style).toEqual({ width: 180 });
    expect(question?.measured).toEqual({ width: 180, height: 240 });
  });

  it('leaves Question height renderer-owned during proportional corner scaling', () => {
    const question: Node = {
      id: 'question',
      type: 'question',
      position: { x: 20, y: 20 },
      data: {},
      style: { width: 360 },
      measured: { width: 360, height: 120 },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [question],
      edges: [],
    });
    beginSnapSession({
      nodes: [question],
      gestureIds: new Set(['question']),
      altPressed: true,
      kind: 'resize',
      resizeContext: {
        nodeId: 'question',
        startRect: { x: 20, y: 20, w: 360, h: 120 },
        startLocalPos: { x: 20, y: 20 },
        parentOffset: { x: 0, y: 0 },
        mode: 'scale',
        lockAspect: true,
      },
    });
    applyResizeProposal({ x: 20, y: 20, width: 540, height: 180 }, 1);
    useCanvasStore.getState().onNodesChange([
      {
        type: 'dimensions',
        id: 'question',
        dimensions: { width: 540, height: 180 },
        resizing: true,
      },
    ]);

    const resized = useCanvasStore.getState().nodes[0];
    expect(resized.style).toEqual({ width: 540 });
    expect(resized.measured).toEqual({ width: 540, height: 180 });
  });

  it('ignores intermediate CSS transition sizes without losing RF resizing state', () => {
    const nodes: Node[] = ['outer', 'middle', 'inner'].map((id, index) => ({
      id,
      type: 'frame',
      parentId: index ? ['outer', 'middle'][index - 1] : undefined,
      position: { x: 20, y: 64 },
      data: {},
      style: { width: 400 - index * 40, height: 400 - index * 84 },
    }));
    useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [] });
    useCanvasStore.getState().onNodesChange([
      {
        type: 'dimensions',
        id: 'middle',
        dimensions: { width: 520, height: 480 },
        resizing: false,
      },
      {
        type: 'dimensions',
        id: 'inner',
        dimensions: { width: 460, height: 400 },
      },
    ]);
    const after = useCanvasStore.getState().nodes;
    expect(after[1].measured).toEqual({ width: 360, height: 316 });
    expect(after[1].resizing).toBe(false);
    expect(after[2].measured).toEqual({ width: 320, height: 232 });
    expect(after.map((n) => n.style)).toEqual(nodes.map((n) => n.style));
  });

  it('mirrors gesture-start coordinates relative to the current parent origin', () => {
    const nodes: Node[] = [
      {
        id: 'outer',
        type: 'frame',
        position: { x: 100, y: 100 },
        style: { width: 500, height: 500 },
        data: {},
      },
      {
        id: 'inner',
        type: 'frame',
        parentId: 'outer',
        position: { x: 20, y: 64 },
        style: { width: 300, height: 200 },
        data: {},
      },
    ];
    useCanvasStore.getState()._setStateNoAutosave({ nodes, edges: [] });
    beginSnapSession({
      nodes,
      gestureIds: new Set(['inner']),
      altPressed: true,
      kind: 'resize',
      resizeContext: {
        nodeId: 'inner',
        startRect: { x: 120, y: 164, w: 300, h: 200 },
        startLocalPos: { x: 20, y: 64 },
        parentOffset: { x: 100, y: 100 },
        lockAspect: false,
      },
    });
    applyResizeProposal({ x: -30, y: 14, width: 350, height: 250 }, 1);
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [{ ...nodes[0], position: { x: 50, y: 50 } }, nodes[1]],
    });
    useCanvasStore.getState().onNodesChange([
      {
        type: 'dimensions',
        id: 'inner',
        dimensions: { width: 350, height: 250 },
        resizing: true,
      },
    ]);
    expect(useCanvasStore.getState().nodes[1].position).toEqual({
      x: 20,
      y: 64,
    });
  });
});
