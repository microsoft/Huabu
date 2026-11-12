// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { executeCanvasCommands } from '../executor.js';
import { includePdfNotes } from '../pdfNotes.js';

import type { CanvasCommand } from '../../types/canvas/command.js';
import type { CanvasNode } from '../interfaces.js';

const pdf: CanvasNode = {
  id: 'node-pdf',
  type: 'pdf',
  position: { x: 10, y: 20 },
  data: { noteNodeId: 'node-note' },
};
const note: CanvasNode = {
  id: 'node-note',
  type: 'note',
  position: { x: 0, y: 0 },
  data: { content: 'My notes' },
  hidden: true,
};
function run(commands: CanvasCommand[], nodes = [pdf, note]) {
  return executeCanvasCommands(
    { source: 'ui', commands },
    { nodes, edges: [], canvasId: 'space' },
  );
}

describe('PDF-owned real Notes', () => {
  it('allows explicit deletion followed by fresh initialization in the same batch', () => {
    const result = run([
      { type: 'DELETE_NODES', nodeIds: ['node-note'] },
      { type: 'INITIALIZE_PDF_NOTE', nodeId: 'node-pdf' },
    ]);
    expect(result.commandResults.every((entry) => entry.applied)).toBe(true);
    const owner = result.writeResult.nodes.find((entry) => entry.id === pdf.id);
    const replacement = result.writeResult.nodes.find(
      (entry) => entry.id === owner?.data.noteNodeId,
    );
    expect(result.writeResult.nodes).toHaveLength(2);
    expect(replacement?.id).not.toBe(note.id);
    expect(replacement).toMatchObject({
      type: 'note',
      hidden: true,
      data: { content: '' },
    });
  });

  it('initializes a Note atomically and reuses it without changing content or selection', () => {
    const command: CanvasCommand = {
      type: 'INITIALIZE_PDF_NOTE',
      nodeId: 'node-pdf',
    };
    const initial = [{ ...pdf, data: {}, selected: true }];
    const created = run([command], initial);
    expect(created.commandResults[0].applied).toBe(true);
    const owner = created.writeResult.nodes.find((node) => node.id === pdf.id);
    const child = created.writeResult.nodes.find(
      (node) => node.id === owner?.data.noteNodeId,
    );
    expect(child).toMatchObject({
      type: 'note',
      hidden: true,
      selected: false,
      data: { content: '' },
    });
    expect(owner?.selected).toBe(true);
    const edited = created.writeResult.nodes.map((node) =>
      node.id === child?.id
        ? { ...node, data: { ...node.data, content: 'Keep my draft' } }
        : node,
    );
    const repeated = run([command], edited);
    expect(repeated.commandResults[0]).toMatchObject({
      applied: false,
      reason: 'no-op',
    });
    expect(repeated.writeResult.nodes).toEqual(edited);
    expect(repeated.pendingEffects.mutatedNodes).toEqual([]);
    expect(repeated.writeResult.snapshotNeeded).toBe(false);
  });

  it.each([
    { nodes: [] },
    { nodes: [{ ...pdf, type: 'note', data: {} }] },
    { nodes: [pdf] },
  ])(
    'rejects invalid initialization targets without partial creation',
    ({ nodes }) => {
      const result = run(
        [{ type: 'INITIALIZE_PDF_NOTE', nodeId: 'node-pdf' }],
        nodes,
      );
      expect(result.commandResults[0].applied).toBe(false);
      expect(result.writeResult.nodes).toEqual(nodes);
      expect(result.pendingEffects.mutatedNodes).toEqual([]);
    },
  );

  const initialize: CanvasCommand[] = [
    {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'node-note',
          nodeType: 'note',
          position: note.position,
          data: note.data,
        },
      ],
    },
    {
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'node-pdf', patch: { noteNodeId: note.id } }],
    },
  ];

  it.each(['ui', 'agent'] as const)(
    'initializes a fresh hidden Note in one %s batch',
    (source) => {
      const result = executeCanvasCommands(
        { source, commands: initialize },
        { nodes: [{ ...pdf, data: {} }], edges: [], canvasId: 'space' },
      );
      expect(result.commandResults.every((entry) => entry.applied)).toBe(true);
      expect(
        result.writeResult.nodes.find((node) => node.id === note.id),
      ).toMatchObject({
        hidden: true,
        selected: false,
        data: { content: 'My notes' },
      });
      expect(
        run([initialize[1]], result.writeResult.nodes).commandResults[0].reason,
      ).not.toBe('invalid-target');
    },
  );

  it.each(['ui', 'agent'] as const)(
    'rejects claiming an existing Note through %s commands',
    (source) => {
      for (const commands of [
        [initialize[1]],
        [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-new-pdf',
                nodeType: 'pdf',
                position: pdf.position,
                data: pdf.data,
              },
            ],
          },
        ],
        [{ type: 'DELETE_NODES', nodeIds: ['node-note'] }, ...initialize],
      ] satisfies CanvasCommand[][]) {
        const result = executeCanvasCommands(
          { source, commands },
          { nodes: [{ ...pdf, data: {} }, note], edges: [], canvasId: 'space' },
        );
        expect(
          result.commandResults[result.commandResults.length - 1],
        ).toMatchObject({
          applied: false,
          reason: 'invalid-target',
        });
        expect(
          result.writeResult.nodes
            .filter((node) => node.type === 'pdf')
            .every((node) => !node.data.noteNodeId),
        ).toBe(true);
      }
    },
  );

  it('rejects simultaneous claims on the same Note in one patch command', () => {
    const result = run(
      [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            { nodeId: 'node-pdf', patch: { noteNodeId: note.id } },
            { nodeId: 'node-other', patch: { noteNodeId: note.id } },
          ],
        },
      ],
      [{ ...pdf, data: {} }, { ...pdf, id: 'node-other', data: {} }, note],
    );
    expect(result.commandResults[0].applied).toBe(false);
  });

  it('creates a linked Note with normal content and a hidden canvas footprint', () => {
    const result = run(
      [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-pdf',
              nodeType: 'pdf',
              position: pdf.position,
              data: pdf.data,
            },
            {
              id: 'node-note',
              nodeType: 'note',
              position: note.position,
              data: note.data,
            },
          ],
        },
      ],
      [],
    );
    expect(result.commandResults[0].applied).toBe(true);
    expect(
      result.writeResult.nodes.find((node) => node.id === note.id),
    ).toMatchObject({
      type: 'note',
      hidden: true,
      selected: false,
      data: { content: 'My notes' },
    });
  });

  it('expands copy and deletion through PDF ownership, including PDFs inside Frames', () => {
    expect(includePdfNotes([pdf, note], new Set([pdf.id]))).toEqual(
      new Set([pdf.id, note.id]),
    );
    const frame: CanvasNode = {
      id: 'node-frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: {},
    };
    const deleted = run(
      [{ type: 'DELETE_NODES', nodeIds: ['node-frame'] }],
      [frame, { ...pdf, parentId: frame.id }, note],
    );
    expect(deleted.writeResult.nodes).toEqual([]);
    expect(deleted.pendingEffects.deletedNodeIds).toEqual(
      expect.arrayContaining([pdf.id, note.id, frame.id]),
    );
  });

  it('clears the owner link when its Note is explicitly deleted', () => {
    const result = run([{ type: 'DELETE_NODES', nodeIds: ['node-note'] }]);
    expect(result.writeResult.nodes).toHaveLength(1);
    expect(result.writeResult.nodes[0].data).not.toHaveProperty('noteNodeId');
  });

  it.each([
    {
      type: 'MERGE_NODE_DATA',
      patches: [{ nodeId: 'node-pdf', patch: { noteNodeId: 'missing' } }],
    },
    { type: 'CHANGE_NODE_TYPE', nodeId: 'node-note', to: 'text' },
    { type: 'SET_NODE_PARENT', nodeIds: ['node-note'], parentId: 'node-pdf' },
  ] satisfies CanvasCommand[])(
    'rejects invalid ownership operations: $type',
    (command) => {
      expect(run([command]).commandResults[0].applied).toBe(false);
    },
  );

  it('does not allow two PDFs to claim the same Note', () => {
    const other = { ...pdf, id: 'node-other', data: {} };
    expect(
      run(
        [
          {
            type: 'MERGE_NODE_DATA',
            patches: [{ nodeId: 'node-other', patch: { noteNodeId: note.id } }],
          },
        ],
        [pdf, note, other],
      ).commandResults[0].applied,
    ).toBe(false);
  });
});
