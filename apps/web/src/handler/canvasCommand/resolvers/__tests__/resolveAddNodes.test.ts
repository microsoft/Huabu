// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import resolveAddNodes from '../resolveAddNodes';
import resolvePasteClipboard from '../resolvePasteClipboard';

import type { CanvasNodeType, SketchStroke } from '@huabu/shared';
import type { Node } from '@xyflow/react';

const ui = { nodes: [], edges: [] };

describe('resolveAddNodes', () => {
  it.each(['note', 'text'] satisfies CanvasNodeType[])(
    'requests editing after explicitly creating one %s node',
    (nodeType) => {
      const resolution = resolveAddNodes(
        {
          type: 'ADD_NODES',
          inputs: [
            {
              id: 'node-new',
              nodeType,
              data: { origin: { type: 'user-created' } },
            },
          ],
        },
        ui,
      );

      expect(resolution.editNodeId).toBe('node-new');
    },
  );

  it.each(['user-excerpt', 'user-from-chat', 'user-uploaded'] as const)(
    'does not request editing for a note created from %s content',
    (originType) => {
      const resolution = resolveAddNodes(
        {
          type: 'ADD_NODES',
          inputs: [
            {
              id: 'node-new',
              nodeType: 'note',
              data: { origin: { type: originType } },
            },
          ],
        },
        ui,
      );

      expect(resolution.editNodeId).toBeUndefined();
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
  it('rebases surviving children before paste placement and drops incident edges', () => {
    const nodes: Node[] = [
      { id: 'old', type: 'canvasRef', position: { x: 100, y: 200 }, data: {} },
      {
        id: 'nested',
        type: 'frameRef',
        parentId: 'old',
        position: { x: 20, y: 30 },
        data: {},
      },
      {
        id: 'kept',
        type: 'frame',
        parentId: 'nested',
        position: { x: 5, y: 6 },
        data: { label: 'Frame' },
      },
      {
        id: 'child',
        type: 'note',
        parentId: 'kept',
        position: { x: 7, y: 8 },
        data: { label: 'Note' },
      },
      {
        id: 'preview',
        type: 'spacePreview',
        position: { x: 500, y: 600 },
        data: { targetCanvasId: 'canvas-target' },
      },
    ];
    const before = JSON.stringify(nodes);
    const resolution = resolvePasteClipboard(
      {
        type: 'PASTE_CLIPBOARD',
        clipboardNodes: nodes,
        clipboardEdges: [
          { id: 'removed', source: 'old', target: 'kept' },
          { id: 'kept-edge', source: 'child', target: 'preview' },
        ],
      },
      ui,
    );
    const create = resolution.commands.find(
      (command) => command.type === 'CREATE_NODES',
    )!;
    const connect = resolution.commands.find(
      (command) => command.type === 'CONNECT_NODES',
    )!;
    expect(create.nodes.map((node) => node.nodeType)).toEqual([
      'frame',
      'note',
      'spacePreview',
    ]);
    expect(create.nodes[0]).toMatchObject({ position: { x: 165, y: 276 } });
    expect(create.nodes[0]).not.toHaveProperty('parentId');
    expect(create.nodes[1]).toMatchObject({
      parentId: create.nodes[0].id,
      position: { x: 7, y: 8 },
    });
    expect(create.nodes[2].data).toMatchObject({
      targetCanvasId: 'canvas-target',
    });
    expect(connect.edges).toHaveLength(1);
    expect(connect.edges[0]).toMatchObject({
      source: create.nodes[1].id,
      target: create.nodes[2].id,
    });
    expect(JSON.stringify(nodes)).toBe(before);
  });

  it.each(['canvasRef', 'nodeRef', 'frameRef'])(
    'does not paste %s reference nodes',
    (type) => {
      const source = {
        id: 'node-ref-source',
        type,
        position: { x: 0, y: 0 },
        data: {
          type,
          target: { canvasId: 'canvas-source', nodeId: 'node-source' },
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
      expect(resolution.commands).toEqual([]);
    },
  );

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
