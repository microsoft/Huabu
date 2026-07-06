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
    const nodes = createNodes({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'created-question' as never,
          nodeType: 'question',
          position: { x: 10, y: 10 },
        },
      ],
    });

    expect(nodes.find((n) => n.id === 'existing')?.selected).toBe(true);
    expect(nodes.find((n) => n.id === 'created-question')?.selected).toBe(
      undefined,
    );
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
