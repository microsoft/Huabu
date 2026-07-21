import { describe, expect, it } from 'vitest';

import resolveAddNodes from '../resolveAddNodes';
import resolvePasteClipboard from '../resolvePasteClipboard';

import type { CanvasNodeType, SketchStroke } from '@sediment/shared';
import type { Node } from '@xyflow/react';

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

  it.each([true, false] as const)(
    'preserves selectOnCreate=%s in the resolved command',
    (selectOnCreate) => {
      const resolution = resolveAddNodes(
        {
          type: 'ADD_NODES',
          inputs: [
            {
              id: 'node-question',
              nodeType: 'question',
              selectOnCreate,
            },
          ],
        },
        ui,
      );

      const create = resolution.commands.find(
        (command) => command.type === 'CREATE_NODES',
      );
      expect(create?.type).toBe('CREATE_NODES');
      if (create?.type !== 'CREATE_NODES') return;
      expect(create.nodes[0].selectOnCreate).toBe(selectOnCreate);
    },
  );

  it('leaves selectOnCreate absent when the caller omits it', () => {
    const resolution = resolveAddNodes(
      {
        type: 'ADD_NODES',
        inputs: [{ id: 'node-question', nodeType: 'question' }],
      },
      ui,
    );

    const create = resolution.commands.find(
      (command) => command.type === 'CREATE_NODES',
    );
    expect(create?.type).toBe('CREATE_NODES');
    if (create?.type !== 'CREATE_NODES') return;
    expect(create.nodes[0]).not.toHaveProperty('selectOnCreate');
  });
});

describe('resolvePasteClipboard', () => {
  it('assigns fresh ids to pasted sketch strokes', () => {
    const source = {
      id: 'sketch-source',
      type: 'sketch',
      position: { x: 0, y: 0 },
      data: {
        type: 'sketch',
        strokes: [
          {
            id: 'stroke-source',
            points: [[0, 0]],
            color: '#000',
            size: 4,
            createdAt: 0,
          },
        ],
      },
    } as unknown as Node;

    const resolution = resolvePasteClipboard(
      {
        type: 'PASTE_CLIPBOARD',
        clipboardNodes: [source],
        clipboardEdges: [],
      },
      { nodes: [source], edges: [] },
    );

    const create = resolution.commands.find(
      (command) => command.type === 'CREATE_NODES',
    );
    expect(create?.type).toBe('CREATE_NODES');
    if (create?.type !== 'CREATE_NODES') return;
    const strokes = (create.nodes[0].data as { strokes: SketchStroke[] })
      .strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0].id).not.toBe('stroke-source');
    expect(strokes[0].points).toEqual([[0, 0]]);
    expect((source.data as { strokes: SketchStroke[] }).strokes[0].id).toBe(
      'stroke-source',
    );
  });
});
