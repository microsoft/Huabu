// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function node(id: string, type = 'note', selected = false): CanvasNode {
  return {
    id,
    type,
    selected,
    position: { x: 0, y: 0 },
    data: { type, label: id },
  } as CanvasNode;
}

function createNodes(
  command: CanvasCommand,
  startNodes: CanvasNode[] = [node('existing', 'note', true)],
) {
  return executeCanvasCommands(
    { source: 'ui', commands: [command] },
    { nodes: startNodes, edges: [] as CanvasEdge[], canvasId: 'c1' },
  ).writeResult.nodes;
}

describe('CREATE_NODES selection', () => {
  it('uses nominal note and question heights for placement without pinning creation height', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'created-note' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
        },
        {
          id: 'created-question' as never,
          nodeType: 'question',
          position: { x: 20, y: 20 },
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'created-note')?.style).toEqual({
      width: 400,
      // Materialized from the note policy's minimum, not pinned: a
      // created note must have a real footprint for the same-batch frame
      // fit and grid solver, and its ownership is recorded explicitly.
      height: 56,
    });
    expect(
      (
        nodes.find((n) => n.id === 'created-note')?.data as {
          heightMode?: string;
        }
      ).heightMode,
    ).toBe('auto');
    expect(nodes.find((n) => n.id === 'created-question')?.style).toEqual({
      width: 200,
    });
  });

  it('preserves explicit note height but keeps explicit question height content-driven', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'fixed-note' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
          size: { width: 300, height: 180 },
        },
        {
          id: 'scaled-question' as never,
          nodeType: 'question',
          position: { x: 20, y: 20 },
          size: { width: 260, height: 140 },
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'fixed-note')?.style).toEqual({
      width: 300,
      height: 180,
    });
    expect(nodes.find((n) => n.id === 'scaled-question')?.style).toEqual({
      width: 260,
    });
  });

  it('keeps SET_NODE_GEOMETRY height content-driven for text and question nodes', () => {
    const output = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [
              {
                nodeId: 'text-node' as never,
                size: { width: 280, height: 140 },
              },
              {
                nodeId: 'question-node' as never,
                size: { width: 260, height: 120 },
              },
              {
                nodeId: 'note-node' as never,
                size: { width: 360, height: 180 },
              },
            ],
          },
        ],
      },
      {
        nodes: [
          {
            ...node('text-node', 'text'),
            style: { width: 200, height: 80 },
          },
          {
            ...node('question-node', 'question'),
            style: { width: 200, height: 80 },
          },
          node('note-node', 'note'),
        ],
        edges: [] as CanvasEdge[],
        canvasId: 'c1',
      },
    );
    const nodes = output.writeResult.nodes;

    expect(nodes.find((n) => n.id === 'text-node')?.style).toEqual({
      width: 280,
    });
    expect(nodes.find((n) => n.id === 'question-node')?.style).toEqual({
      width: 260,
    });
    expect(nodes.find((n) => n.id === 'note-node')?.style).toEqual({
      width: 360,
      height: 180,
    });
  });

  it('drops top-level height when converting a note into a text node', () => {
    const output = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'CHANGE_NODE_TYPE',
            nodeId: 'note-node' as never,
            to: 'text',
          },
        ],
      },
      {
        nodes: [
          {
            ...node('note-node', 'note'),
            data: { type: 'note', label: 'note-node', content: '**Hello**' },
            style: { width: 360, height: 180 },
            measured: { width: 360, height: 180 },
          },
        ],
        edges: [] as CanvasEdge[],
        canvasId: 'c1',
      },
    );
    const converted = output.writeResult.nodes.find(
      (n) => n.id === 'note-node',
    );

    expect(converted?.type).toBe('text');
    expect(converted?.style).toEqual({ width: 360 });
    expect(converted?.data.content).toBe('Hello');
  });

  it('selects user-created non-question nodes and clears the old selection', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'created-a' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
        },
        {
          id: 'created-b' as never,
          nodeType: 'text',
          position: { x: 20, y: 20 },
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(false);
    expect(nodes.find((n) => n.id === 'created-a')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'created-b')?.selected).toBe(true);
  });

  it('does not select question nodes created through CREATE_NODES', () => {
    const command: CanvasCommand = {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'created-question' as never,
          nodeType: 'question',
          data: { content: 'What should we do next?' },
          position: { x: 10, y: 10 },
        },
      ],
    };
    const output = executeCanvasCommands(
      { source: 'ui', commands: [command] },
      {
        nodes: [node('existing', 'note', true)],
        edges: [] as CanvasEdge[],
        canvasId: 'c1',
      },
    );
    const nodes = output.writeResult.nodes;

    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'created-question')?.selected).toBe(
      undefined,
    );
    expect(output.pendingEffects.mutatedNodes.map((n) => n.id)).toEqual([
      'created-question',
    ]);
  });

  it('does not auto-select a UI node created with selectOnCreate:false', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'no-select' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
          selectOnCreate: false,
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'no-select')?.selected).toBeFalsy();
    // Nothing new was selected, so the prior selection is preserved.
    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(true);
  });

  it('still auto-selects a normally created UI node (selectOnCreate defaults true)', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'new-note' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'new-note')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(false);
  });

  it('force-selects a question created with selectOnCreate:true (paste/duplicate)', () => {
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'pasted-question' as never,
          nodeType: 'question',
          position: { x: 10, y: 10 },
          selectOnCreate: true,
        },
      ],
    });

    // Overrides the default question exclusion so the pasted copy is
    // selected (and the prior selection is cleared).
    expect(nodes.find((n) => n.id === 'pasted-question')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(false);
  });

  it('preserves selection for agent-created nodes', () => {
    const command: CanvasCommand = {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'agent-created' as never,
          nodeType: 'note',
          position: { x: 10, y: 10 },
        },
      ],
    };
    const nodes = executeCanvasCommands(
      { source: 'agent', commands: [command] },
      {
        nodes: [node('existing', 'note', true)],
        edges: [] as CanvasEdge[],
        canvasId: 'c1',
      },
    ).writeResult.nodes;

    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'agent-created')?.selected).toBe(
      undefined,
    );
  });
});
