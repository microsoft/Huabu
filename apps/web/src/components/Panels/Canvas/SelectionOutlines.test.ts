// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { selectOutlinedNodes } from './SelectionOutlines';

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
