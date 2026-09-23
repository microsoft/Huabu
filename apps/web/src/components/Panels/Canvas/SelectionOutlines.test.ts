// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  selectionOutlineRadius,
  selectionOutlineSize,
  selectOutlinedNodes,
} from './SelectionOutlines';

import type { CanvasNode } from '@/components/Nodes/types';

function node(
  id: string,
  state: { selected?: boolean; dragging?: boolean } = {},
): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    ...state,
  } as CanvasNode;
}

describe('selectOutlinedNodes', () => {
  it('keeps a drag outline when Ctrl or Cmd toggled selection off first', () => {
    expect(selectOutlinedNodes([node('dragged', { dragging: true })])).toEqual([
      expect.objectContaining({ id: 'dragged' }),
    ]);
  });

  it('includes selected and dragged nodes without outlining idle peers', () => {
    expect(
      selectOutlinedNodes([
        node('selected', { selected: true }),
        node('dragged', { dragging: true }),
        node('idle'),
      ]).map((candidate) => candidate.id),
    ).toEqual(['selected', 'dragged']);
  });
});

describe('selectionOutlineRadius', () => {
  it('matches the responsive radius of ordinary node shells', () => {
    expect(selectionOutlineRadius('note', 200, 100)).toBe(12);
    expect(selectionOutlineRadius('note', 600, 400)).toBe(18);
    expect(selectionOutlineRadius('note', 1200, 900)).toBe(24);
  });

  it('matches the separate responsive radius of Frame shells', () => {
    expect(selectionOutlineRadius('frame', 200, 100)).toBe(16);
    expect(selectionOutlineRadius('frame', 1200, 900)).toBe(24);
    expect(selectionOutlineRadius('frame', 2400, 1800)).toBe(32);
  });
});

describe('selectionOutlineSize', () => {
  it('uses live measured height for an auto-height Question during width resize', () => {
    const question = {
      ...node('question', { selected: true }),
      type: 'question',
      style: { width: 320, height: 240 },
      measured: { width: 320, height: 160 },
    } as CanvasNode;
    const internalNode = { measured: { width: 320, height: 104 } };

    expect(selectionOutlineSize(question, internalNode)).toEqual({
      width: 320,
      height: 104,
    });
  });

  it('keeps explicit preview or persisted dimensions authoritative', () => {
    const preview = {
      ...node('note', { selected: true }),
      style: { width: 480, height: 240 },
      measured: { width: 400, height: 200 },
    } as CanvasNode;
    const internalNode = { measured: { width: 410, height: 210 } };

    expect(selectionOutlineSize(preview, internalNode)).toEqual({
      width: 480,
      height: 240,
    });
  });
});
