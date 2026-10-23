// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  autoHeightKey,
  executeCanvasCommands,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { parseHuabuClipboard } from '@/utils/io/clipboard';

import resolveAddNodes from '../resolveAddNodes';
import resolvePasteClipboard from '../resolvePasteClipboard';

import type {
  CanvasNodeId,
  CanvasNodeType,
  Point,
  SketchStroke,
} from '@huabu/shared';
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

describe.each(['column', 'row'] as const)(
  'resolveAddNodes in a %s Frame',
  (axis) => {
    const frameId = 'node-frame';
    const field = axis === 'column' ? 'frameColumn' : 'frameRow';
    const along = axis === 'column' ? 'y' : 'x';

    function scene(sizing = 'hug', nested = false): Node[] {
      const nodes: Node[] = [
        ...(nested
          ? [
              {
                id: 'outer',
                type: 'frame',
                position: { x: 300, y: 400 },
                data: { sizing: 'manual' },
                style: { width: 1600, height: 1600 },
              },
            ]
          : []),
        {
          id: frameId,
          type: 'frame',
          ...(nested ? { parentId: 'outer' } : {}),
          position: { x: 100, y: 200 },
          data: { layoutMode: axis, gridCount: 2, sizing },
          style: { width: 800, height: 800 },
        },
        ...['other', 'first', 'middle', 'last'].map((id, index) => ({
          id,
          type: 'note',
          parentId: frameId,
          position: { x: index * 100, y: index * 100 },
          data: { [field]: index === 0 ? 0 : 1, heightMode: 'fixed' },
          style: { width: 120, height: 80 },
        })),
      ];
      const layout = solveStructuredFrameLayout(nodes, frameId, 'compact');
      if (!layout) throw new Error('Missing fixture layout');
      return nodes.map((node) => ({
        ...node,
        position: layout.childPositions.get(node.id) ?? node.position,
      }));
    }

    function createAt(nodes: Node[], point?: Point, explicitParent = false) {
      const before = JSON.stringify(nodes);
      const resolution = resolveAddNodes(
        {
          type: 'ADD_NODES',
          inputs: [
            {
              id: 'node-new',
              nodeType: 'note',
              size: { width: 120, height: 80 },
              ...(explicitParent ? { parentId: frameId } : {}),
              ...(point ? { placementPoint: point } : {}),
            },
          ],
        },
        { nodes, edges: [] },
      );
      const committed = executeCanvasCommands(
        { source: 'ui', commands: resolution.commands },
        { nodes, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes;
      expect(JSON.stringify(nodes)).toBe(before);
      return committed;
    }

    it.each(
      ['hug', 'manual'].flatMap((sizing) =>
        [0, 1, 3].map((index) => ({ sizing, index })),
      ),
    )(
      'inserts at position $index in the pointed track ($sizing)',
      ({ sizing, index }) => {
        const nodes = scene(sizing);
        const peers = nodes.filter((node) => node.data[field] === 1);
        const anchor = peers[Math.min(index, peers.length - 1)].position;
        const local = {
          ...anchor,
          [along]: anchor[along] + (index === peers.length ? 100 : -5),
        };
        const committed = createAt(nodes, {
          x: 100 + local.x,
          y: 200 + local.y,
        });
        const added = committed.find((node) => node.id === 'node-new');
        expect(added).toMatchObject({
          parentId: frameId,
          data: { [field]: 1 },
        });
        const expected = peers.map((node) => node.id);
        expected.splice(index, 0, 'node-new');
        expect(
          committed
            .filter(
              (node) => node.parentId === frameId && node.data[field] === 1,
            )
            .sort((a, b) => a.position[along] - b.position[along])
            .map((node) => node.id),
        ).toEqual(expected);
        expect(
          committed.find((node) => node.id === frameId)?.data.gridCount,
        ).toBe(2);
      },
    );

    it.each([false, true])(
      'uses parent-local coordinates in nested Frames (explicit parent: %s)',
      (explicitParent) => {
        const nodes = scene('manual', true);
        const local = nodes.find((node) => node.id === 'middle')?.position;
        if (!local) throw new Error('Missing middle node');
        const point = explicitParent
          ? local
          : { x: 400 + local.x, y: 600 + local.y };
        expect(
          createAt(nodes, point, explicitParent).find(
            (node) => node.id === 'node-new',
          ),
        ).toMatchObject({ parentId: frameId, data: { [field]: 1 } });
      },
    );

    it('keeps automatic track assignment without a placement point', () => {
      expect(
        createAt(scene(), undefined, true).find(
          (node) => node.id === 'node-new',
        ),
      ).toMatchObject({ parentId: frameId, data: { [field]: 0 } });
    });

    it('uses the nearest existing track in a gutter without creating one', () => {
      const nodes = scene();
      const layout = solveStructuredFrameLayout(nodes, frameId, 'compact');
      const column = layout?.columnTracks?.[1];
      const row = layout?.rowTracks?.[1];
      const start = axis === 'column' ? column?.left : row?.top;
      if (start === undefined) throw new Error('Missing second track');
      const local =
        axis === 'column' ? { x: start - 1, y: 100 } : { x: 100, y: start - 1 };
      const committed = createAt(nodes, { x: 100 + local.x, y: 200 + local.y });
      expect(
        committed.find((node) => node.id === 'node-new')?.data[field],
      ).toBe(1);
      expect(
        committed.find((node) => node.id === frameId)?.data.gridCount,
      ).toBe(2);
    });

    it('creates beside the nearer boundary of unequal tracks', () => {
      const dimension = axis === 'column' ? 'width' : 'height';
      const nodes = scene().map((node) =>
        node.id === 'other'
          ? { ...node, style: { ...node.style, [dimension]: 400 } }
          : node,
      );
      const layout = solveStructuredFrameLayout(nodes, frameId);
      const column = layout?.columnTracks?.[0];
      const row = layout?.rowTracks?.[0];
      const end =
        axis === 'column'
          ? column && column.left + column.width
          : row && row.top + row.height;
      if (end === undefined) throw new Error('Missing first track');
      const local =
        axis === 'column' ? { x: end + 1, y: 100 } : { x: 100, y: end + 1 };
      const committed = createAt(nodes, { x: 100 + local.x, y: 200 + local.y });
      expect(committed.find((node) => node.id === 'node-new')).toMatchObject({
        parentId: frameId,
        data: { [field]: 0 },
      });
    });
  },
);

describe('resolvePasteClipboard', () => {
  it.each([
    {
      name: 'legacy auto',
      height: undefined,
      heightMode: undefined,
      expected: 56,
      mode: 'auto',
    },
    {
      name: 'legacy fixed',
      height: 172,
      heightMode: undefined,
      expected: 172,
      mode: 'fixed',
    },
    {
      name: 'explicit auto',
      height: 388,
      heightMode: 'auto',
      expected: 388,
      mode: 'auto',
    },
    {
      name: 'explicit fixed',
      height: 224,
      heightMode: 'fixed',
      expected: 224,
      mode: 'fixed',
    },
  ] as const)(
    'preserves $name ownership when pasting serialized Notes',
    ({ height, heightMode, expected, mode }) => {
      const source: Node = {
        id: 'source',
        type: 'note',
        position: { x: 0, y: 0 },
        style: { width: 560, ...(height === undefined ? {} : { height }) },
        data: {
          content: 'Copied content',
          ...(heightMode ? { heightMode } : {}),
        },
      };
      const clipboard = parseHuabuClipboard(
        JSON.stringify({ __huabu_nodes__: [source] }),
      );
      if (!clipboard) throw new Error('Invalid clipboard fixture');
      const before = JSON.stringify(clipboard.nodes);
      const resolution = resolvePasteClipboard(
        {
          type: 'PASTE_CLIPBOARD',
          clipboardNodes: clipboard.nodes as Node[],
        },
        ui,
      );
      const nodes = executeCanvasCommands(
        { source: 'ui', commands: resolution.commands },
        { ...ui, canvasId: 'canvas' },
      ).writeResult.nodes;
      const note = nodes[0];
      expect(note.id).not.toBe(source.id);
      expect(note.data.heightMode).toBe(mode);
      expect(note.style).toMatchObject({ width: 560, height: expected });
      const measured = executeCanvasCommands(
        {
          source: 'system',
          commands: [
            {
              type: 'APPLY_MEASURED_HEIGHT',
              items: [
                {
                  nodeId: note.id as CanvasNodeId,
                  intrinsicHeight: 420,
                  measuredFor: autoHeightKey(note),
                },
              ],
            },
          ],
        },
        { nodes, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes[0];
      expect(measured.style?.height).toBe(mode === 'auto' ? 424 : expected);
      expect(JSON.stringify(clipboard.nodes)).toBe(before);
    },
  );

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
