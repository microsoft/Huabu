// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { normalizeFrameHeaderInsets } from '../normalizeFrameHeaderInsets';

import type { Node } from '@xyflow/react';

function frame(sizing: 'hug' | 'manual' = 'hug'): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 100, y: 100 },
    data: { sizing },
    style: { width: 500, height: 300 },
    measured: { width: 500, height: 300 },
  } as Node;
}

function child(): Node {
  return {
    id: 'child',
    type: 'note',
    parentId: 'frame',
    position: { x: 40, y: 40 },
    data: {},
    style: { width: 400, height: 400 },
    measured: { width: 400, height: 400 },
  } as Node;
}

describe('normalizeFrameHeaderInsets', () => {
  it('converges after expanding across a responsive boundary', () => {
    const nodes = [
      {
        ...frame(),
        style: { width: 1000, height: 800 },
        measured: { width: 1000, height: 800 },
      },
      { ...child(), position: { x: 20, y: 20 } },
    ];
    const result = normalizeFrameHeaderInsets(nodes);
    expect(result[0].style?.height).toBe(876);
    expect(result[0].position.y).toBe(24);
    expect(result[1].position.y).toBe(96);
    expect(normalizeFrameHeaderInsets(result)).toBe(result);
  });

  it('preserves nested child absolute positions and converges bottom-up', () => {
    const outer = {
      ...frame(),
      id: 'outer',
      style: { width: 1000, height: 800 },
      measured: { width: 1000, height: 800 },
    };
    const inner = { ...frame(), parentId: 'outer', position: { x: 20, y: 20 } };
    const nodes = [outer, inner, child()];
    const result = normalizeFrameHeaderInsets(nodes);
    expect(
      result[0].position.y + result[1].position.y + result[2].position.y,
    ).toBe(160);
    expect(normalizeFrameHeaderInsets(result)).toBe(result);
  });

  it('leaves locked Frames unchanged', () => {
    const nodes = [
      { ...frame(), data: { sizing: 'hug', locked: true } },
      child(),
    ];
    expect(normalizeFrameHeaderInsets(nodes)).toBe(nodes);
  });
  it('expands a legacy Hug Frame upward without moving child content', () => {
    const result = normalizeFrameHeaderInsets([frame(), child()]);
    const nextFrame = result.find((node) => node.id === 'frame');
    const nextChild = result.find((node) => node.id === 'child');

    expect(nextFrame).toMatchObject({
      position: { x: 100, y: 76 },
      style: { width: 500, height: 324 },
    });
    expect(nextChild?.position).toEqual({ x: 40, y: 64 });
    if (!nextFrame || !nextChild) throw new Error('Expected normalized nodes');
    expect(nextFrame.position.y + nextChild.position.y).toBe(140);
  });

  it('preserves Manual Frame geometry', () => {
    const nodes = [frame('manual'), child()];
    expect(normalizeFrameHeaderInsets(nodes)).toBe(nodes);
  });

  it('is reference-stable once the responsive inset is present', () => {
    const nodes = [frame(), { ...child(), position: { x: 40, y: 96 } } as Node];
    expect(normalizeFrameHeaderInsets(nodes)).toBe(nodes);
  });
});
