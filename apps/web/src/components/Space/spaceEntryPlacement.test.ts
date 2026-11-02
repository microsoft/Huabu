// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNodeDefaultSize } from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

import { getSpaceEntryPosition } from './spaceEntryPlacement';

import type { Node, ReactFlowInstance } from '@xyflow/react';

vi.mock('@/store/canvasStore', () => ({
  default: { getState: vi.fn() },
}));

const size = getNodeDefaultSize('spacePreview');
const ideal = { x: 640 - size.width / 2, y: 400 - (size.height || 100) / 2 };
let nodes: Node[];
let wrapper: HTMLDivElement;

beforeEach(() => {
  nodes = [];
  wrapper = document.createElement('div');
  document.body.appendChild(wrapper);
  Object.defineProperties(wrapper, {
    clientWidth: { value: 1280 },
    clientHeight: { value: 800 },
  });
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1280, 800),
  );
  const instance: Pick<
    ReactFlowInstance,
    'screenToFlowPosition' | 'getIntersectingNodes' | 'getInternalNode'
  > = {
    screenToFlowPosition: (point) => point,
    getIntersectingNodes: (rect) =>
      nodes.filter(
        (node) =>
          'x' in rect &&
          rect.x < node.position.x + (node.width ?? 0) &&
          rect.x + (rect.width ?? 0) > node.position.x &&
          rect.y < node.position.y + (node.height ?? 0) &&
          rect.y + (rect.height ?? 0) > node.position.y,
      ),
    getInternalNode: (id) => {
      const node = nodes.find((node) => node.id === id);
      return node
        ? {
            ...node,
            measured: { width: node.width, height: node.height },
            internals: {
              positionAbsolute: node.position,
              userNode: node,
              z: 0,
            },
          }
        : undefined;
    },
  };
  vi.mocked(useCanvasStore.getState).mockReturnValue({
    ...useCanvasStore.getState(),
    nodes,
    rfInstance: instance as ReactFlowInstance,
    canvasWrapper: wrapper,
    viewport: null,
  });
});

afterEach(() => {
  wrapper.remove();
  vi.restoreAllMocks();
});

describe('Space entry placement', () => {
  it('centres the card even when other content is far away', () => {
    nodes.push({
      id: 'far',
      type: 'note',
      data: {},
      position: { x: 20000, y: 20000 },
      width: 400,
      height: 300,
    });
    expect(getSpaceEntryPosition()).toEqual(ideal);
  });

  it('reuses adjacent placement to avoid a central obstacle within the viewport', () => {
    nodes.push({
      id: 'middle',
      type: 'note',
      data: {},
      position: { x: 440, y: 250 },
      width: 400,
      height: 300,
    });
    const position = getSpaceEntryPosition();
    expect(position).not.toEqual(ideal);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + size.width).toBeLessThanOrEqual(1280);
    expect(position.y + (size.height || 100)).toBeLessThanOrEqual(800);
    expect(
      useCanvasStore.getState().rfInstance?.getIntersectingNodes({
        ...position,
        width: size.width,
        height: size.height || 100,
      }),
    ).toHaveLength(0);
  });

  it('keeps a crowded viewport centred rather than using a distant free position', () => {
    nodes.push({
      id: 'full',
      type: 'note',
      data: {},
      position: { x: 0, y: 0 },
      width: 1280,
      height: 800,
    });
    expect(getSpaceEntryPosition()).toEqual(ideal);
  });

  it('subtracts panel insets when finding the visible centre', () => {
    wrapper.style.setProperty('--canvas-inset-right', '400px');
    expect(getSpaceEntryPosition()).toEqual({ x: ideal.x - 200, y: ideal.y });
  });

  it('refuses placement without a live or stored viewport', () => {
    vi.mocked(useCanvasStore.getState).mockReturnValue({
      ...useCanvasStore.getState(),
      rfInstance: null,
      canvasWrapper: null,
      viewport: null,
    });
    expect(() => getSpaceEntryPosition()).toThrow();
  });
});
