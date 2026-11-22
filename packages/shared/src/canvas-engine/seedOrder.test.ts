// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { readTrackKey } from './autoLayout/layoutOrder.js';
import { readPaintKey } from './container/paintOrder.js';
import { executeCanvasCommands } from './executor.js';
import { seedNodeOrder } from './seedOrder.js';

import { describeFrameLayout } from './index.js';

import type { CanvasNode } from './interfaces.js';

/** A Space as it was stored before nodes carried order keys. */
function storedSpace(mode: 'column' | 'row'): CanvasNode[] {
  const field = mode === 'column' ? 'frameColumn' : 'frameRow';
  const child = (id: string, track: number, at: number): CanvasNode =>
    ({
      id,
      type: 'note',
      parentId: 'frame',
      zIndex: -1,
      // Deliberately not where the list says: the list is the order.
      position:
        mode === 'column' ? { x: 0, y: 500 - at } : { x: 500 - at, y: 0 },
      style: { width: 100, height: 60 },
      data: { [field]: track },
    }) as CanvasNode;
  return [
    { id: 'back', type: 'note', position: { x: -500, y: 0 }, data: {} },
    {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 400, height: 400 },
      data: {
        layoutMode: mode,
        gridCount: 2,
        layoutOrder: [
          ['c', 'a'],
          ['b', 'gone'],
        ],
      },
    },
    child('a', 0, 10),
    child('b', 1, 20),
    child('c', 0, 30),
    { id: 'front', type: 'note', position: { x: 900, y: 0 }, data: {} },
  ] as CanvasNode[];
}

describe.each(['column', 'row'] as const)(
  'seedNodeOrder (%s Frame)',
  (mode) => {
    it('keeps paint order and reading order, and drops the Frame list', () => {
      const stored = storedSpace(mode);
      const seeded = seedNodeOrder(stored) as CanvasNode[];

      expect(seeded.map((node) => node.id)).toEqual(
        stored.map((node) => node.id),
      );
      expect(seeded.every((node) => readPaintKey(node) !== undefined)).toBe(
        true,
      );
      const frame = seeded.find((node) => node.id === 'frame');
      expect(frame?.data).not.toHaveProperty('layoutOrder');
      expect(describeFrameLayout(seeded, 'frame')).toEqual({
        mode,
        tracks: [['c', 'a'], ['b']],
      });
      const key = (id: string) =>
        readTrackKey(seeded.find((node) => node.id === id) as CanvasNode);
      expect((key('c') as string) < (key('a') as string)).toBe(true);
      expect(key('b')).toBeDefined();
      // Nodes outside the Frame have no track key.
      expect(key('back')).toBeUndefined();
    });

    it('gives the same keys on every read and changes nothing once seeded', () => {
      const once = seedNodeOrder(storedSpace(mode));
      expect(seedNodeOrder(storedSpace(mode))).toEqual(once);
      expect(seedNodeOrder(once)).toBe(once);
    });

    it('a batch on the seeded Space rewrites only what it changes', () => {
      const seeded = seedNodeOrder(storedSpace(mode)) as CanvasNode[];
      const out = executeCanvasCommands(
        {
          source: 'ui',
          commands: [
            {
              type: 'SET_FRAME_LAYOUT',
              frameId: 'frame' as never,
              mode,
              placements: [{ nodeId: 'a' as never, before: 'c' as never }],
            },
          ],
        },
        { canvasId: 'space', nodes: seeded, edges: [] },
      );
      const next = out.writeResult.nodes as CanvasNode[];
      expect(describeFrameLayout(next, 'frame')).toEqual({
        mode,
        tracks: [['a', 'c'], ['b']],
      });
      const before = new Map(seeded.map((node) => [node.id, node]));
      const rekeyed = next
        .filter(
          (node) =>
            readTrackKey(node) !== readTrackKey(before.get(node.id) as never),
        )
        .map((node) => node.id);
      expect(rekeyed).toEqual(['a']);
      expect(
        next.every(
          (node) =>
            readPaintKey(node) === readPaintKey(before.get(node.id) as never),
        ),
      ).toBe(true);
    });
  },
);

/**
 * A Column / Row Frame stored before reading order was stored at all (before
 * `layoutOrder`, #386): its children read by coordinate, and children that
 * tie on the coordinate read in array order. Nothing recorded that order.
 */
describe.each(['column', 'row'] as const)(
  'seedNodeOrder (%s Frame stored without any reading order)',
  (mode) => {
    const field = mode === 'column' ? 'frameColumn' : 'frameRow';
    const at = (along: number) =>
      mode === 'column' ? { x: 30, y: along } : { x: along, y: 80 };
    const child = (id: string, along: number): CanvasNode =>
      ({
        id,
        type: 'note',
        parentId: 'frame',
        zIndex: -1,
        position: at(along),
        style: { width: 100, height: 60 },
        data: { [field]: 0 },
      }) as CanvasNode;
    const stored = (): CanvasNode[] =>
      [
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          style: { width: 400, height: 600 },
          data: { layoutMode: mode, gridCount: 1, sizing: 'manual' },
        },
        // `tie-b` and `tie-a` share a coordinate: array order decides.
        child('second', 200),
        child('tie-b', 80),
        child('tie-a', 80),
      ] as CanvasNode[];
    const tracks = (nodes: CanvasNode[]) => {
      const layout = describeFrameLayout(nodes, 'frame');
      return layout && 'tracks' in layout ? layout.tracks : undefined;
    };

    it('records the order the children read in, on every child', () => {
      const before = tracks(stored());
      expect(before).toEqual([['tie-b', 'tie-a', 'second']]);

      const seeded = seedNodeOrder(stored()) as CanvasNode[];
      expect(tracks(seeded)).toEqual(before);
      const keys = ['tie-b', 'tie-a', 'second'].map((id) =>
        readTrackKey(seeded.find((node) => node.id === id) as CanvasNode),
      );
      expect(keys.every((key) => key !== undefined)).toBe(true);
      expect([...keys].sort()).toEqual(keys);
      // Geometry is not touched: seeding records order, it does not lay out.
      expect(seeded.map((node) => node.position)).toEqual(
        stored().map((node) => node.position),
      );
      expect(seedNodeOrder(stored())).toEqual(seeded);
      expect(seedNodeOrder(seeded)).toBe(seeded);
    });

    it('keeps that order when the array order behind a tie later changes', () => {
      const seeded = seedNodeOrder(stored()) as CanvasNode[];
      // The tied children swap places in the array, as a different paint
      // order or a rebuilt array would leave them.
      const swapped = [seeded[0], seeded[1], seeded[3], seeded[2]];
      expect(tracks(swapped)).toEqual([['tie-b', 'tie-a', 'second']]);
      // Without the recorded order the tie would follow the array.
      expect(
        tracks([stored()[0], stored()[1], stored()[3], stored()[2]]),
      ).toEqual([['tie-a', 'tie-b', 'second']]);
    });
  },
);
