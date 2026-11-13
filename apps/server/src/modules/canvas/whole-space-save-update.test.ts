// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { wholeSpaceSaveUpdate } from './whole-space-save-update.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

const note = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'note',
  position: { x, y: 0 },
  data: { label: id },
  ...extra,
});
/** Stored content by node id; nodes without any are returned as they are. */
const bodies: Record<string, string> = { a: 'Body of a', d: 'Body of d' };
const hydrate = async (nodes: readonly CanvasNode[]) =>
  nodes.map((node) =>
    node.id in bodies
      ? { ...node, data: { ...node.data, content: bodies[node.id] } }
      : { ...node },
  );
const withBody = <T extends { id: string; data: Record<string, unknown> }>(
  node: T,
) => ({ ...node, data: { ...node.data, content: bodies[node.id] } });
const noEffects = {
  mutatedNodes: [],
  deletedNodeIds: [],
  contentEditedNodeIds: [],
  deferredFitFrameIds: [],
};

describe('wholeSpaceSaveUpdate', () => {
  it('publishes a save that changed nothing as the update that carries the version on', async () => {
    const nodes = [note('a', 0), note('b', 100)];
    const read = vi.fn(hydrate);
    expect(
      await wholeSpaceSaveUpdate(
        { version: 4, title: 'Space', nodes, edges: [] },
        {
          version: 5,
          title: 'Space',
          nodes: structuredClone(nodes),
          edges: [],
        },
        read,
      ),
    ).toEqual({
      type: 'update',
      data: {
        fromVersion: 4,
        toVersion: 5,
        deltas: [],
        pendingEffects: noEffects,
        source: 'ui',
      },
    });
    // No content is read for a node the save did not touch.
    expect(read).not.toHaveBeenCalled();
  });

  it('publishes what the save changed as entity deltas with stored content, without view flags', async () => {
    const a = note('a', 0);
    const b = note('b', 100);
    const c = note('c', 200);
    const edge = { id: 'e1', source: 'a', target: 'b' };
    const moved = { ...a, position: { x: 50, y: 0 }, selected: true };
    const added = note('d', 300);
    const read = vi.fn(hydrate);
    const update = await wholeSpaceSaveUpdate(
      { version: 4, title: 'Space', nodes: [a, b, c], edges: [edge] },
      {
        version: 5,
        title: 'Space',
        // `b` only gained a selection flag: not a change to the Space.
        nodes: [moved, { ...b, selected: true }, added],
        edges: [],
      },
      read,
    );
    const movedOnServer = { ...a, position: { x: 50, y: 0 } };
    expect(update).toEqual({
      type: 'update',
      data: {
        fromVersion: 4,
        toVersion: 5,
        deltas: [
          { type: 'DELETE_NODE', node: c },
          { type: 'INSERT_NODE', node: withBody(added) },
          {
            type: 'REPLACE_NODE',
            // The same stored body on both sides: the save did not change it,
            // and a page that replaces whole nodes keeps it.
            prev: withBody(a),
            next: withBody(movedOnServer),
          },
          { type: 'DELETE_EDGE', edge },
        ],
        pendingEffects: {
          ...noEffects,
          mutatedNodes: [withBody(added), withBody(movedOnServer)],
          deletedNodeIds: ['c'],
        },
        orderEvents: expect.any(Array),
        source: 'ui',
      },
    });
    // Content is read once, and only for the nodes inserted or changed.
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0].map((node) => node.id)).toEqual([
      'd',
      'a',
      'a',
    ]);
  });

  it('carries a changed sibling order, which entity deltas cannot express', async () => {
    const nodes = [note('a', 0), note('b', 100)];
    const update = await wholeSpaceSaveUpdate(
      { version: 1, title: null, nodes, edges: [] },
      { version: 2, title: null, nodes: [nodes[1], nodes[0]], edges: [] },
      hydrate,
    );
    expect(update).toMatchObject({
      type: 'update',
      data: {
        deltas: [],
        orderEvents: [
          expect.objectContaining({ parentId: null, orderVersion: 2 }),
        ],
      },
    });
  });

  it('carries a new title', async () => {
    const update = await wholeSpaceSaveUpdate(
      { version: 1, title: 'Before', nodes: [], edges: [] },
      { version: 2, title: 'After', nodes: [], edges: [] },
      hydrate,
    );
    expect(update).toMatchObject({ data: { title: 'After' } });
  });
});
