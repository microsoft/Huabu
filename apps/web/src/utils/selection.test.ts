// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { applyEdgeChanges, type Edge } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { selectionChangeForShownSelectedEdge } from './selection';

const edge = (patch: Partial<Edge> = {}): Edge => ({
  id: 'e',
  source: 'a',
  target: 'b',
  ...patch,
});

describe('selectionChangeForShownSelectedEdge', () => {
  it('selects an edge that is only shown selected through its two ends', () => {
    const edges = [edge({ selected: false }), edge({ id: 'other' })];
    const changes = selectionChangeForShownSelectedEdge({
      edgeId: 'e',
      edges,
      selectedNodeIds: new Set(['a', 'b']),
      multiSelect: false,
    });
    expect(changes).toEqual([{ id: 'e', type: 'select', selected: true }]);
    expect(
      applyEdgeChanges(changes, edges).map((entry) => !!entry.selected),
    ).toEqual([true, false]);
  });

  it('leaves the pick to React Flow when the edge is not shown selected', () => {
    for (const selectedNodeIds of [new Set<string>(), new Set(['a'])]) {
      expect(
        selectionChangeForShownSelectedEdge({
          edgeId: 'e',
          edges: [edge()],
          selectedNodeIds,
          multiSelect: false,
        }),
      ).toEqual([]);
    }
  });

  it('changes nothing for a selected, unselectable or unknown edge, or a modified pick', () => {
    const selectedNodeIds = new Set(['a', 'b']);
    const base = { edgeId: 'e', selectedNodeIds, multiSelect: false };
    expect(
      selectionChangeForShownSelectedEdge({
        ...base,
        edges: [edge({ selected: true })],
      }),
    ).toEqual([]);
    expect(
      selectionChangeForShownSelectedEdge({
        ...base,
        edges: [edge({ selectable: false })],
      }),
    ).toEqual([]);
    expect(selectionChangeForShownSelectedEdge({ ...base, edges: [] })).toEqual(
      [],
    );
    expect(
      selectionChangeForShownSelectedEdge({
        ...base,
        edges: [edge()],
        multiSelect: true,
      }),
    ).toEqual([]);
  });
});
