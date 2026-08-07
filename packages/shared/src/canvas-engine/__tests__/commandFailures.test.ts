// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function node(id: string, type = 'note'): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { type, label: id },
  } as CanvasNode;
}

function frame(id: string): CanvasNode {
  return {
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { type: 'frame', label: id },
  } as CanvasNode;
}

function run(
  command: CanvasCommand,
  nodes: CanvasNode[],
  edges: CanvasEdge[] = [],
) {
  return executeCanvasCommands(
    { source: 'agent', commands: [command] },
    { nodes, edges, canvasId: 'c1' },
  );
}

describe('CONNECT_NODES — visible endpoint failures', () => {
  it('rejects the whole command with invalid-target when a target is missing', () => {
    const { commandResults, writeResult } = run(
      {
        type: 'CONNECT_NODES',
        edges: [{ source: 'a', target: 'ghost' }],
      } as unknown as CanvasCommand,
      [node('a')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-target');
    // Nothing was connected — no silent partial application.
    expect(writeResult.edges).toHaveLength(0);
  });

  it('rejects the whole command when a source is missing', () => {
    const { commandResults, writeResult } = run(
      {
        type: 'CONNECT_NODES',
        edges: [{ source: 'ghost', target: 'b' }],
      } as unknown as CanvasCommand,
      [node('b')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-target');
    expect(writeResult.edges).toHaveLength(0);
  });

  it('does not apply any edge when one of several endpoints is missing', () => {
    const { commandResults, writeResult } = run(
      {
        type: 'CONNECT_NODES',
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'ghost' },
        ],
      } as unknown as CanvasCommand,
      [node('a'), node('b')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-target');
    // The valid edge is NOT applied — the whole command is gated so the
    // agent gets one clear signal to fix its ids and retry.
    expect(writeResult.edges).toHaveLength(0);
  });

  it('connects successfully when all endpoints exist', () => {
    const { commandResults, writeResult } = run(
      {
        type: 'CONNECT_NODES',
        edges: [{ source: 'a', target: 'b' }],
      } as unknown as CanvasCommand,
      [node('a'), node('b')],
    );

    expect(commandResults[0].applied).toBe(true);
    expect(commandResults[0].reason).toBeUndefined();
    expect(writeResult.edges).toHaveLength(1);
  });
});

describe('SET_NODE_PARENT — visible target/parent failures', () => {
  it('rejects with invalid-target when the node to reparent is missing', () => {
    const { commandResults } = run(
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['ghost'],
        parentId: 'frame-1',
      } as unknown as CanvasCommand,
      [frame('frame-1')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-target');
  });

  it('rejects with invalid-parent when the target frame is missing', () => {
    const { commandResults } = run(
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['a'],
        parentId: 'ghost-frame',
      } as unknown as CanvasCommand,
      [node('a')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-parent');
  });

  it('rejects with invalid-parent when the target is not a Container', () => {
    const { commandResults } = run(
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['a'],
        parentId: 'b',
      } as unknown as CanvasCommand,
      [node('a'), node('b')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-parent');
  });

  it('reparents successfully when both node and frame exist', () => {
    const { commandResults, writeResult } = run(
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['a'],
        parentId: 'frame-1',
      } as unknown as CanvasCommand,
      [node('a'), frame('frame-1')],
    );

    expect(commandResults[0].applied).toBe(true);
    expect(writeResult.nodes.find((n) => n.id === 'a')?.parentId).toBe(
      'frame-1',
    );
  });

  it('rejects a mixed batch when any reparent would create a cycle', () => {
    const outer = frame('outer');
    const inner = { ...frame('inner'), parentId: 'outer' };
    const { commandResults, writeResult } = run(
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['outer', 'free'],
        parentId: 'inner',
      } as unknown as CanvasCommand,
      [outer, inner, node('free')],
    );

    expect(commandResults[0].applied).toBe(false);
    expect(commandResults[0].reason).toBe('invalid-parent');
    expect(
      writeResult.nodes.find((n) => n.id === 'free')?.parentId,
    ).toBeUndefined();
  });
});
