import { describe, expect, it } from 'vitest';

import resolveAddNodes from '../resolveAddNodes';

import type { CanvasNodeType } from '@sediment/shared';

const ui = { nodes: [], edges: [] };

describe('resolveAddNodes', () => {
  it.each(['note', 'text'] satisfies CanvasNodeType[])(
    'requests editing after creating one %s node',
    (nodeType) => {
      const resolution = resolveAddNodes(
        {
          type: 'ADD_NODES',
          inputs: [{ id: 'node-new', nodeType }],
        },
        ui,
      );

      expect(resolution.editNodeId).toBe('node-new');
    },
  );

  it('does not request editing for other node types', () => {
    const resolution = resolveAddNodes(
      {
        type: 'ADD_NODES',
        inputs: [{ id: 'node-image', nodeType: 'image' }],
      },
      ui,
    );

    expect(resolution.editNodeId).toBeUndefined();
  });

  it('does not choose an arbitrary editor for a batch', () => {
    const resolution = resolveAddNodes(
      {
        type: 'ADD_NODES',
        inputs: [
          { id: 'node-note', nodeType: 'note' },
          { id: 'node-text', nodeType: 'text' },
        ],
      },
      ui,
    );

    expect(resolution.editNodeId).toBeUndefined();
  });
});
