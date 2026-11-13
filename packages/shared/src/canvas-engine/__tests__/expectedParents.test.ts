// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { postCanvasExecuteBodySchema } from '../../types/api/canvas.js';
import {
  commandPlacementTargets,
  createExpectedParentsAdmit,
  executeCanvasCommands,
  expectedParentsOf,
  expectedParentsProblem,
  type ExpectedParents,
} from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

const N = 'node-n';
const M = 'node-m';
const F = 'node-f';
const G = 'node-g';

function note(id: string, x: number, y: number, parentId?: string): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x, y },
    style: { width: 100, height: 60 },
    ...(parentId ? { parentId } : {}),
    data: { type: 'note', label: id, heightMode: 'fixed' },
  } as CanvasNode;
}

function frame(id: string, x: number): CanvasNode {
  return {
    id,
    type: 'frame',
    position: { x, y: 0 },
    style: { width: 300, height: 300 },
    data: { type: 'frame', label: id, sizing: 'manual' },
  } as CanvasNode;
}

const move = (id: string, x: number, y: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: id, position: { x, y } }],
  }) as unknown as CanvasCommand;
const reparent = (id: string, parentId: string | null): CanvasCommand =>
  ({
    type: 'SET_NODE_PARENT',
    nodeIds: [id],
    parentId,
  }) as unknown as CanvasCommand;
const recolour = (id: string): CanvasCommand =>
  ({
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: id, patch: { style: { accent: 'blue' } } }],
  }) as unknown as CanvasCommand;

function run(
  commands: CanvasCommand[],
  nodes: CanvasNode[],
  expected?: ExpectedParents[],
) {
  const out = executeCanvasCommands(
    { source: 'ui', commands },
    { nodes, edges: [], canvasId: 'c1' },
    expected ? { admit: createExpectedParentsAdmit(commands, expected) } : {},
  );
  const byId = new Map(out.writeResult.nodes.map((node) => [node.id, node]));
  return {
    reasons: out.commandResults.map((result) =>
      result.applied ? 'applied' : (result.reason ?? 'not-applied'),
    ),
    node: (id: string) => byId.get(id),
  };
}

/** N on the canvas, M inside F, G empty. */
const scene = (): CanvasNode[] => [
  note(N, 500, 500),
  frame(F, 0),
  note(M, 20, 40, F),
  frame(G, 1000),
];

describe('commandPlacementTargets', () => {
  it('names the nodes whose parent a command depends on', () => {
    expect(
      commandPlacementTargets({
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: N, position: { x: 1, y: 2 } },
          // A size means the same in any container.
          { nodeId: M, size: { width: 10 } },
        ],
      } as unknown as CanvasCommand),
    ).toEqual([N]);
    expect(commandPlacementTargets(reparent(N, F))).toEqual([N]);
    expect(
      commandPlacementTargets({
        type: 'REORDER_NODES',
        nodeIds: [N],
        to: { after: M },
      } as unknown as CanvasCommand),
    ).toEqual([N, M]);
    expect(
      commandPlacementTargets({
        type: 'ALIGN_NODES',
        nodeIds: [N, M],
        direction: 'left',
      } as unknown as CanvasCommand),
    ).toEqual([N, M]);
    expect(
      commandPlacementTargets({
        type: 'SET_FRAME_LAYOUT',
        frameId: F,
        mode: 'grid',
        cells: [{ nodeId: M, column: 1, row: 0 }],
      } as unknown as CanvasCommand),
    ).toEqual([M]);
    expect(
      commandPlacementTargets({
        type: 'SET_FRAME_LAYOUT',
        frameId: F,
        mode: 'column',
        placements: [{ nodeId: M, after: N }],
      } as unknown as CanvasCommand),
    ).toEqual([M, N]);
    expect(commandPlacementTargets(recolour(N))).toEqual([]);
    expect(
      commandPlacementTargets({
        type: 'DELETE_NODES',
        nodeIds: [N],
      } as unknown as CanvasCommand),
    ).toEqual([]);
  });
});

describe('expectedParentsOf', () => {
  it('reads the parent of every placed node the author had', () => {
    expect(expectedParentsOf([move(N, 1, 2), move(M, 3, 4)], scene())).toEqual({
      [N]: null,
      [M]: F,
    });
  });

  it('leaves out nodes the edit brings into existence itself', () => {
    expect(expectedParentsOf([move('node-new', 1, 2)], scene())).toBeNull();
  });

  it('states nothing for commands that place nothing', () => {
    expect(expectedParentsOf([recolour(N)], scene())).toBeNull();
  });
});

describe('expected parents on execute', () => {
  it('admits a move made under the parent the node still has', () => {
    const onCanvas = run([move(N, 10, 20)], scene(), [
      { start: 0, count: 1, parents: { [N]: null } },
    ]);
    expect(onCanvas.reasons).toEqual(['applied']);
    expect(onCanvas.node(N)?.position).toEqual({ x: 10, y: 20 });

    const inFrame = run([move(M, 50, 60)], scene(), [
      { start: 0, count: 1, parents: { [M]: F } },
    ]);
    expect(inFrame.reasons).toEqual(['applied']);
    expect(inFrame.node(M)?.position).toEqual({ x: 50, y: 60 });
  });

  it('refuses a canvas move of a node that is inside a Frame by now', () => {
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, F) : node,
    );
    const out = run([move(N, 700, 700)], nodes, [
      { start: 0, count: 1, parents: { [N]: null } },
    ]);
    expect(out.reasons).toEqual(['stale-parent']);
    // Not read as Frame-local coordinates.
    expect(out.node(N)?.position).toEqual({ x: 30, y: 30 });
    expect(out.node(N)?.parentId).toBe(F);
  });

  it('refuses a move inside a Frame of a node that has left it (the mirror case)', () => {
    const nodes = scene().map((node) =>
      node.id === M ? note(M, 800, 800) : node,
    );
    const out = run([move(M, 50, 60)], nodes, [
      { start: 0, count: 1, parents: { [M]: F } },
    ]);
    expect(out.reasons).toEqual(['stale-parent']);
    expect(out.node(M)?.position).toEqual({ x: 800, y: 800 });
  });

  it('runs the same commands as before when no parents are stated', () => {
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, F) : node,
    );
    const out = run([move(N, 700, 700)], nodes);
    expect(out.reasons).toEqual(['applied']);
    expect(out.node(N)?.position).toEqual({ x: 700, y: 700 });
  });

  it('refuses the run with stale-target when a node it places is gone', () => {
    const nodes = scene().filter((node) => node.id !== N);
    const out = run([move(N, 1, 1), move(M, 50, 60)], nodes, [
      { start: 0, count: 2, parents: { [N]: null, [M]: F } },
    ]);
    expect(out.reasons).toEqual(['stale-target', 'stale-target']);
    expect(out.node(M)?.position).toEqual({ x: 20, y: 40 });
  });

  it('refuses a drag into a Frame when the node is no longer where it was dragged from', () => {
    // Another page put N into F first; this one drags it "from the canvas"
    // into G.
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, F) : node,
    );
    const out = run([reparent(N, G), move(N, 5, 5)], nodes, [
      { start: 0, count: 2, parents: { [N]: null } },
    ]);
    expect(out.reasons).toEqual(['stale-parent', 'stale-parent']);
    expect(out.node(N)?.parentId).toBe(F);
    expect(out.node(N)?.position).toEqual({ x: 30, y: 30 });
  });

  it('refuses every command of the run, also for nodes whose parent still matches', () => {
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, F) : node,
    );
    const commands = [
      reparent(M, G),
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: N, position: { x: 700, y: 700 } },
          { nodeId: M, position: { x: 9, y: 9 } },
        ],
      } as unknown as CanvasCommand,
      recolour(M),
    ];
    const out = run(commands, nodes, [
      { start: 0, count: 3, parents: { [N]: null, [M]: F } },
    ]);
    // No parent change without its position, no recolour of half a gesture.
    expect(out.reasons).toEqual([
      'stale-parent',
      'stale-parent',
      'stale-parent',
    ]);
    expect(out.node(M)?.parentId).toBe(F);
    expect(out.node(M)?.position).toEqual({ x: 20, y: 40 });
  });

  it('judges each run on its own and leaves commands outside every run alone', () => {
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, F) : node,
    );
    const out = run([move(N, 700, 700), recolour(N), move(M, 50, 60)], nodes, [
      { start: 0, count: 1, parents: { [N]: null } },
      { start: 2, count: 1, parents: { [M]: F } },
    ]);
    expect(out.reasons).toEqual(['stale-parent', 'applied', 'applied']);
    expect(out.node(M)?.position).toEqual({ x: 50, y: 60 });
  });

  it('reads parents the way a page shows them: no retired portal parent, no missing one', () => {
    const nodes = [
      { ...note('node-ref', 0, 0), type: 'canvasRef' } as CanvasNode,
      note(N, 5, 5, 'node-ref'),
      note(M, 5, 5, 'node-gone'),
    ];
    const out = run([move(N, 10, 10), move(M, 20, 20)], nodes, [
      { start: 0, count: 2, parents: { [N]: null, [M]: null } },
    ]);
    expect(out.reasons).toEqual(['applied', 'applied']);
  });

  it('judges a run against what earlier commands of the batch left', () => {
    // Drag into F, then move inside F: the second edit was made under F.
    const applied = run([reparent(N, F), move(N, 5, 5)], scene(), [
      { start: 0, count: 1, parents: { [N]: null } },
      { start: 1, count: 1, parents: { [N]: F } },
    ]);
    expect(applied.reasons).toEqual(['applied', 'applied']);
    expect(applied.node(N)?.parentId).toBe(F);
    expect(applied.node(N)?.position).toEqual({ x: 5, y: 5 });

    // The first edit is refused (N is in G by now), so the one built on it
    // is refused as well.
    const nodes = scene().map((node) =>
      node.id === N ? note(N, 30, 30, G) : node,
    );
    const refused = run([reparent(N, F), move(N, 5, 5)], nodes, [
      { start: 0, count: 1, parents: { [N]: null } },
      { start: 1, count: 1, parents: { [N]: F } },
    ]);
    expect(refused.reasons).toEqual(['stale-parent', 'stale-parent']);
    expect(refused.node(N)?.parentId).toBe(G);
  });
});

describe('expectedParents on the wire', () => {
  const body = (expectedParents: unknown) => ({
    commands: [move(N, 1, 2)],
    originator: { source: 'ui' },
    expectedParents,
  });

  it('is optional and accepts null for the canvas', () => {
    expect(
      postCanvasExecuteBodySchema.safeParse({
        commands: [],
        originator: { source: 'ui' },
      }).success,
    ).toBe(true);
    expect(
      postCanvasExecuteBodySchema.safeParse(
        body([{ start: 0, count: 1, parents: { [N]: null, [M]: F } }]),
      ).success,
    ).toBe(true);
  });

  it('rejects a malformed run', () => {
    for (const run of [
      { start: -1, count: 1, parents: {} },
      { start: 0, count: 0, parents: {} },
      { start: 0, count: 1, parents: { [N]: '' } },
      { start: 0, count: 1, parents: {}, extra: true },
    ]) {
      expect(postCanvasExecuteBodySchema.safeParse(body([run])).success).toBe(
        false,
      );
    }
  });

  it('reports runs that do not fit the batch', () => {
    expect(
      expectedParentsProblem([{ start: 0, count: 2, parents: {} }], 2),
    ).toBeNull();
    expect(
      expectedParentsProblem([{ start: 1, count: 2, parents: {} }], 2),
    ).toMatch(/does not have/);
    expect(
      expectedParentsProblem(
        [
          { start: 0, count: 2, parents: {} },
          { start: 1, count: 1, parents: {} },
        ],
        2,
      ),
    ).toMatch(/twice/);
  });
});
