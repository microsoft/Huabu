// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../index.js';

import type {
  CanvasCommand,
  CanvasExecutionSource,
} from '../../types/canvas/index.js';
import type { CanvasEdge, CanvasNode } from '../interfaces.js';

function node(
  id: string,
  type = 'note',
  extra: Record<string, unknown> = {},
): CanvasNode {
  return {
    id,
    type,
    position: { x: 10, y: 20 },
    data: { type, label: id },
    ...extra,
  } as CanvasNode;
}

function edge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target } as CanvasEdge;
}

function restore(
  command: Record<string, unknown>,
  nodes: CanvasNode[],
  edges: CanvasEdge[] = [],
  source: CanvasExecutionSource = 'ui',
) {
  return executeCanvasCommands(
    {
      source,
      commands: [
        { type: 'RESTORE_NODES', ...command } as unknown as CanvasCommand,
      ],
    },
    { nodes, edges, canvasId: 'c1' },
  );
}

describe('RESTORE_NODES', () => {
  it('inserts a node with its id, content and place in the tree', () => {
    const frame = node('f', 'frame', {
      style: { width: 400, height: 300 },
      data: { type: 'frame', label: 'f', sizing: 'manual' },
    });
    const child = node('n', 'note', {
      parentId: 'f',
      style: { width: 200, height: 120 },
      data: {
        type: 'note',
        label: 'n',
        content: '# body',
        heightMode: 'fixed',
      },
    });
    const { commandResults, writeResult, pendingEffects } = restore(
      { nodes: [child], edges: [edge('e', 'f', 'n')] },
      [frame],
    );
    expect(commandResults[0].applied).toBe(true);
    const restored = writeResult.nodes.find((n) => n.id === 'n');
    expect(restored).toMatchObject({
      parentId: 'f',
      position: { x: 10, y: 20 },
      style: { width: 200, height: 120 },
      data: { content: '# body', heightMode: 'fixed' },
    });
    // The Frame is not fitted around what came back.
    expect(writeResult.nodes.find((n) => n.id === 'f')?.style).toEqual({
      width: 400,
      height: 300,
    });
    expect(writeResult.edges).toEqual([edge('e', 'f', 'n')]);
    // The host writes the restored content.
    expect(pendingEffects.mutatedNodes.map((n) => n.id)).toEqual(['n']);
  });

  it('restores a parent and its child given in either order', () => {
    const frame = node('f', 'frame');
    const child = node('n', 'note', { parentId: 'f' });
    const { commandResults, writeResult } = restore(
      { nodes: [child, frame] },
      [],
    );
    expect(commandResults[0].applied).toBe(true);
    // Parents precede children after the batch.
    expect(writeResult.nodes.map((n) => n.id)).toEqual(['f', 'n']);
  });

  it('drops runtime fields of the snapshot', () => {
    const { writeResult } = restore(
      { nodes: [node('n', 'note', { selected: true, dragging: true })] },
      [],
    );
    expect(writeResult.nodes[0]).not.toHaveProperty('selected');
    expect(writeResult.nodes[0]).not.toHaveProperty('dragging');
  });

  it('refuses an id that already exists', () => {
    const before = [node('n')];
    const { commandResults, writeResult } = restore(
      { nodes: [node('n'), node('m')] },
      before,
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'duplicate-id',
    });
    expect(writeResult.nodes).toBe(before);
  });

  it('refuses a node whose parent does not exist', () => {
    const { commandResults } = restore(
      { nodes: [node('n', 'note', { parentId: 'gone' })] },
      [],
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-parent',
    });
  });

  it('refuses a parent that is not a container, and a loop', () => {
    expect(
      restore({ nodes: [node('n', 'note', { parentId: 'p' })] }, [node('p')])
        .commandResults[0],
    ).toMatchObject({ applied: false, reason: 'invalid-parent' });
    expect(
      restore(
        {
          nodes: [
            node('a', 'frame', { parentId: 'b' }),
            node('b', 'frame', { parentId: 'a' }),
          ],
        },
        [],
      ).commandResults[0],
    ).toMatchObject({ applied: false, reason: 'cycle' });
  });

  it('admits a node under a locked Frame only as the member it was', () => {
    const locked = node('f', 'frame', {
      data: { type: 'frame', label: 'f', locked: true },
    });
    expect(
      restore({ nodes: [node('n', 'note', { parentId: 'f' })] }, [locked])
        .commandResults[0],
    ).toMatchObject({ applied: false, reason: 'invalid-parent' });
    expect(
      restore(
        { nodes: [node('n', 'note', { parentId: 'f', draggable: false })] },
        [locked],
      ).commandResults[0].applied,
    ).toBe(true);
  });

  it('refuses to insert an Agent Node', () => {
    const { commandResults } = restore({ nodes: [node('q', 'question')] }, []);
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-target',
    });
  });

  it('refuses an edge whose endpoint is missing', () => {
    const { commandResults } = restore(
      { nodes: [], edges: [edge('e', 'a', 'ghost')] },
      [node('a')],
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'not-found',
    });
  });

  it('replaces the edge that has the same id', () => {
    const { writeResult } = restore(
      {
        nodes: [],
        edges: [{ ...edge('e', 'a', 'b'), data: { style: { color: 'red' } } }],
      },
      [node('a'), node('b')],
      [edge('e', 'a', 'b')],
    );
    expect(writeResult.edges).toEqual([
      { ...edge('e', 'a', 'b'), data: { style: { color: 'red' } } },
    ]);
  });

  describe('replace', () => {
    it('replaces a named node in place and keeps the listed data keys', () => {
      const current = node('n', 'text', {
        measured: { width: 90, height: 30 },
        data: { type: 'text', label: 'now', content: 'now', extra: 1 },
      });
      const snapshot = node('n', 'note', {
        style: { width: 300, height: 200 },
        data: { type: 'note', label: 'then', content: 'then' },
      });
      const { commandResults, writeResult, pendingEffects } = restore(
        {
          nodes: [snapshot],
          replace: ['n'],
          keepDataKeys: ['content', 'label'],
        },
        [node('first'), current],
      );
      expect(commandResults[0].applied).toBe(true);
      expect(writeResult.nodes.map((n) => n.id)).toEqual(['first', 'n']);
      expect(writeResult.nodes[1]).toMatchObject({
        type: 'note',
        style: { width: 300, height: 200 },
        measured: { width: 90, height: 30 },
        data: { type: 'note', label: 'now', content: 'now' },
      });
      expect(writeResult.nodes[1].data).not.toHaveProperty('extra');
      // Its stored content is left to its own writer.
      expect(pendingEffects.mutatedNodes).toEqual([]);
    });

    it('refuses a replace target that does not exist', () => {
      const { commandResults } = restore(
        { nodes: [node('n')], replace: ['n'] },
        [],
      );
      expect(commandResults[0]).toMatchObject({
        applied: false,
        reason: 'not-found',
      });
    });

    it('keeps what an Agent Node owns and never changes its type', () => {
      const current = node('q', 'question', {
        data: { type: 'question', threadId: 't1', status: 'running' },
      });
      const kept = restore(
        {
          nodes: [
            node('q', 'question', {
              position: { x: 5, y: 5 },
              data: { type: 'question', threadId: 'other', status: 'idle' },
            }),
          ],
          replace: ['q'],
        },
        [current],
      );
      expect(kept.writeResult.nodes[0]).toMatchObject({
        position: { x: 5, y: 5 },
        data: { threadId: 't1', status: 'running' },
      });
      expect(
        restore({ nodes: [node('q', 'note')], replace: ['q'] }, [current])
          .commandResults[0],
      ).toMatchObject({ applied: false, reason: 'invalid-target' });
    });
  });

  it('is refused for an agent batch', () => {
    const { commandResults } = restore({ nodes: [node('n')] }, [], [], 'agent');
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-scope',
    });
  });

  it('refuses a malformed snapshot', () => {
    const { commandResults } = restore(
      { nodes: [{ id: 'n', type: 'note', data: {} }] },
      [],
    );
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-target',
    });
  });
});
