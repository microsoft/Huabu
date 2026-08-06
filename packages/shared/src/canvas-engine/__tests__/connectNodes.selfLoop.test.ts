// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for the `CONNECT_NODES` self-loop guard.
 *
 * An edge whose source and target are the same node carries no meaning and
 * is awkward to select/delete, so the shared command drops it silently as a
 * no-op (the command still applies) rather than failing the whole batch.
 * This is the server/agent-side counterpart to React Flow's
 * `isValidConnection` guard on the client.
 */

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function node(id: string): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { type: 'note', label: id },
  } as CanvasNode;
}

function connect(
  edges: Array<{ source: string; target: string; id?: string }>,
  nodes: CanvasNode[],
) {
  const command = { type: 'CONNECT_NODES', edges } as CanvasCommand;
  return executeCanvasCommands(
    { source: 'ui', commands: [command] },
    { nodes, edges: [] as CanvasEdge[], canvasId: 'c1' },
  ).writeResult;
}

describe('CONNECT_NODES self-loop guard', () => {
  it('drops a self-loop edge without failing the command', () => {
    const result = connect([{ source: 'a', target: 'a' }], [node('a')]);
    expect(result.edges).toHaveLength(0);
  });

  it('keeps valid edges while dropping self-loops in the same batch', () => {
    const result = connect(
      [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'b' },
      ],
      [node('a'), node('b')],
    );
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: 'a', target: 'b' });
  });
});
