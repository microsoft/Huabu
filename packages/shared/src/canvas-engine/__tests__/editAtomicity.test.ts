// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * An edit takes effect as a whole or not at all; a list of commands is one
 * edit per command.
 */

import { describe, expect, it } from 'vitest';

import {
  createReadVersionAdmission,
  executeCanvasCommands,
  executeCanvasEdits,
} from '../index.js';

import type { CanvasCommand, CanvasEdit } from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

const note = (id: string, x = 0, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'note',
    position: { x, y: 0 },
    style: { width: 200, height: 100 },
    data: { label: id, content: `body of ${id}` },
    ...(parentId ? { parentId, extent: 'parent' } : {}),
  }) as CanvasNode;

const frame = (id: string, x = 1000): CanvasNode =>
  ({
    id,
    type: 'frame',
    position: { x, y: 0 },
    style: { width: 600, height: 400 },
    data: { label: id },
  }) as CanvasNode;

const move = (nodeId: string, x: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId, position: { x, y: 0 } }],
  }) as CanvasCommand;
const recolour = (nodeId: string, color: string): CanvasCommand =>
  ({
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId, patch: { color } }],
  }) as CanvasCommand;
const reparent = (nodeId: string, parentId: string | null): CanvasCommand =>
  ({ type: 'SET_NODE_PARENT', nodeIds: [nodeId], parentId }) as CanvasCommand;
const remove = (...nodeIds: string[]): CanvasCommand =>
  ({ type: 'DELETE_NODES', nodeIds }) as CanvasCommand;
const create = (id: string, content = 'new'): CanvasCommand =>
  ({
    type: 'CREATE_NODES',
    nodes: [
      {
        id,
        nodeType: 'note',
        position: { x: 0, y: 0 },
        data: { label: id, content },
      },
    ],
  }) as unknown as CanvasCommand;
/** `child` is already in `f`: the command is understood and changes nothing. */
const alreadyThere = (): CanvasCommand => reparent('child', 'f');

const start = (): CanvasNode[] => [
  note('a', 0),
  note('b', 300),
  frame('f'),
  note('child', 20, 'f'),
];

function run(edits: CanvasEdit[], nodes = start()) {
  const out = executeCanvasEdits(
    { source: 'agent', edits },
    { nodes, edges: [], canvasId: 'c1' },
  );
  return { ...out, nodes };
}

const outcome = (out: ReturnType<typeof run>) =>
  out.editResults.map((edit) => ({
    applied: edit.applied,
    ...(edit.reason ? { reason: edit.reason } : {}),
    ...(edit.failedAt !== undefined ? { failedAt: edit.failedAt } : {}),
    results: edit.results.map((result) =>
      result.applied ? 'applied' : (result.reason ?? 'not-applied'),
    ),
  }));

describe('an edit is all-or-nothing', () => {
  it('a failure in the middle leaves nothing of the edit', () => {
    const out = run([
      {
        commands: [
          move('a', 50),
          // The Frame cannot become its own child.
          reparent('f', 'f'),
          recolour('b', 'red'),
        ],
      },
    ]);
    expect(outcome(out)).toEqual([
      {
        applied: false,
        reason: 'invalid-parent',
        failedAt: 1,
        results: ['not-applied', 'invalid-parent', 'not-applied'],
      },
    ]);
    // The very state it started from: no half-applied move.
    expect(out.writeResult.nodes).toBe(out.nodes);
    expect(out.writeResult.snapshotNeeded).toBe(false);
    expect(out.writeResult.requiresEdgeReroute).toBe(false);
    expect(out.commandResults.map((result) => result.applied)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('discards everything the edit accumulated', () => {
    const out = run([
      {
        commands: [
          // Each of these stages something for the end of the batch.
          create('made', 'created body'),
          recolour('a', 'blue'),
          { ...move('child', 400) },
          remove('b'),
          reparent('f', 'f'),
        ],
      },
    ]);
    expect(out.editResults[0]).toMatchObject({ applied: false, failedAt: 4 });
    expect(out.pendingEffects).toEqual({
      mutatedNodes: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    });
    expect(out.writeResult.nodes).toBe(out.nodes);
    // The Frame was not refitted around a child that did not move.
    expect(out.writeResult.nodes.find((node) => node.id === 'f')).toBe(
      out.nodes.find((node) => node.id === 'f'),
    );
  });

  it('applies the other edits of the request, and fits frames for them only', () => {
    const base = run([{ commands: [move('child', 300)] }]);
    const mixed = run([
      { commands: [move('child', 900), reparent('f', 'f')] },
      { commands: [move('child', 300)] },
      { commands: [recolour('a', 'green'), remove('missing-node')] },
    ]);
    expect(outcome(mixed).map((edit) => edit.applied)).toEqual([
      false,
      true,
      false,
    ]);
    expect(outcome(mixed)[2]).toMatchObject({
      reason: 'not-found',
      failedAt: 1,
    });
    // Exactly what the surviving edit alone gives: the refused edits left
    // no position, no colour and no frame fit behind.
    expect(mixed.writeResult.nodes).toEqual(base.writeResult.nodes);
    expect(mixed.pendingEffects).toEqual(base.pendingEffects);
  });

  it('a later edit sees the state the earlier ones left', () => {
    const out = run([
      { commands: [create('made')] },
      { commands: [recolour('made', 'red'), move('made', 70)] },
    ]);
    expect(outcome(out).map((edit) => edit.applied)).toEqual([true, true]);
    const made = out.writeResult.nodes.find((node) => node.id === 'made');
    expect(made?.data.color).toBe('red');
    expect(made?.position.x).toBe(70);
  });

  it('a no-op does not fail the edit', () => {
    const out = run([
      {
        commands: [alreadyThere(), move('a', 50)],
      },
      // An edit of no-ops only took effect: nothing in it failed.
      { commands: [alreadyThere()] },
    ]);
    expect(outcome(out)).toEqual([
      { applied: true, results: ['no-op', 'applied'] },
      { applied: true, results: ['no-op'] },
    ]);
    expect(
      out.writeResult.nodes.find((node) => node.id === 'a')?.position.x,
    ).toBe(50);
  });

  it('reports a no-op inside a refused edit as the no-op it was', () => {
    const out = run([
      { commands: [alreadyThere(), move('a', 5), remove('nope')] },
    ]);
    expect(outcome(out)).toEqual([
      {
        applied: false,
        reason: 'not-found',
        failedAt: 2,
        results: ['no-op', 'not-applied', 'not-found'],
      },
    ]);
  });
});

describe('an edit made on top of another', () => {
  it('does not run when that one did not take effect; unrelated edits apply', () => {
    const out = run([
      { commands: [reparent('a', 'f'), reparent('f', 'f')] },
      { commands: [move('a', 10)], after: [0] },
      { commands: [move('b', 310)] },
      { commands: [recolour('a', 'red')], after: [1] },
    ]);
    expect(outcome(out)).toEqual([
      {
        applied: false,
        reason: 'invalid-parent',
        failedAt: 1,
        results: ['not-applied', 'invalid-parent'],
      },
      { applied: false, reason: 'stale-parent', results: ['stale-parent'] },
      { applied: true, results: ['applied'] },
      { applied: false, reason: 'stale-parent', results: ['stale-parent'] },
    ]);
    const a = out.writeResult.nodes.find((node) => node.id === 'a');
    expect(a).toBe(out.nodes.find((node) => node.id === 'a'));
    expect(
      out.writeResult.nodes.find((node) => node.id === 'b')?.position.x,
    ).toBe(310);
  });

  it('runs when that one took effect', () => {
    const out = run([
      { commands: [reparent('a', 'f')] },
      { commands: [move('a', 10)], after: [0] },
    ]);
    expect(outcome(out).map((edit) => edit.applied)).toEqual([true, true]);
  });

  it('does not run when made on a refused edit of an earlier request, or on a later one', () => {
    const out = run([
      { commands: [move('a', 10)], blocked: true },
      { commands: [move('b', 20)], after: [2] },
      { commands: [move('b', 30)] },
    ]);
    expect(outcome(out).map((edit) => edit.applied)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('the read version of an edit', () => {
  it('is judged once, before the first command, for the whole edit', () => {
    const nodes = start();
    const edits = [
      // `a` was re-parented by someone else at version 12.
      { commands: [recolour('b', 'red'), move('a', 5)], version: 10 },
      { commands: [recolour('b', 'blue')], version: 10 },
    ];
    let asked = 0;
    const admission = createReadVersionAdmission({
      edits,
      stamps: { floor: 10, nodes: { a: { created: 10, membership: 12 } } },
      prestateNodes: nodes,
    });
    const out = executeCanvasEdits(
      { source: 'ui', edits },
      { nodes, edges: [], canvasId: 'c1' },
      {
        admitEdit: (edit, index, state) => {
          asked += 1;
          return admission.admitEdit(edit, index, state);
        },
      },
    );
    expect(asked).toBe(2);
    expect(
      out.editResults.map((edit) => [edit.applied, edit.reason, edit.failedAt]),
    ).toEqual([
      [false, 'stale-parent', undefined],
      [true, undefined, undefined],
    ]);
    // The recolour that shared the stale edit was not applied.
    expect(out.commandResults.map((result) => result.reason)).toEqual([
      'stale-parent',
      'stale-parent',
      undefined,
    ]);
    expect(
      out.writeResult.nodes.find((node) => node.id === 'b')?.data.color,
    ).toBe('blue');
  });
});

describe('a list of commands is one edit per command', () => {
  it('skips the command that fails and applies the first and the third', () => {
    const commands = [move('a', 50), reparent('f', 'f'), recolour('b', 'red')];
    const nodes = start();
    const out = executeCanvasCommands(
      { source: 'agent', commands },
      { nodes, edges: [], canvasId: 'c1' },
    );
    expect(
      out.commandResults.map((result) => [result.applied, result.reason]),
    ).toEqual([
      [true, undefined],
      [false, 'invalid-parent'],
      [true, undefined],
    ]);
    expect(out.commandResults.map((result) => result.command)).toEqual(
      commands,
    );
    expect(out.editResults.map((edit) => edit.applied)).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      out.writeResult.nodes.find((node) => node.id === 'a')?.position.x,
    ).toBe(50);
    expect(
      out.writeResult.nodes.find((node) => node.id === 'b')?.data.color,
    ).toBe('red');
    // The same commands as one edit: nothing applies.
    const atomic = executeCanvasEdits(
      { source: 'agent', edits: [{ commands }] },
      { nodes, edges: [], canvasId: 'c1' },
    );
    expect(atomic.writeResult.nodes).toBe(nodes);
  });
});
