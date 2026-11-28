// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  describeFrameLayout,
  describeStructuredDropZone,
  executeCanvasCommands,
  seedNodeOrder,
  solveStructuredFrameLayout,
} from '@huabu/shared/canvas-engine';

import { resolveMasonryDrop } from '../../../masonryDrop';
import { resolveUiIntent } from '../../uiIntent';

import type { CanvasNodeId } from '@huabu/shared';
import type { Node } from '@xyflow/react';

describe.each(['column', 'row'] as const)(
  'resolveNodeDragStop nodes dragged together in a %s Frame',
  (axis) => {
    const column = axis === 'column';
    const field = column ? 'frameColumn' : 'frameRow';
    // A track is read along this coordinate; Frames sit apart on the other.
    const along = column ? 'y' : 'x';
    const across = column ? 'x' : 'y';
    const size = { width: 120, height: 60 };

    /**
     * A Frame and its children. `tracks` states reading order the stored way
     * (a list on the Frame); `seedNodeOrder` turns it into the children's
     * own track keys, as loading a Space does.
     */
    function frame(id: string, offset: number, tracks: string[][]): Node[] {
      return [
        {
          id,
          type: 'frame',
          position: { x: 0, y: 0, [across]: offset },
          data: {
            layoutMode: axis,
            gridCount: tracks.length,
            sizing: 'hug',
            layoutOrder: tracks,
          },
          style: { width: 400, height: 800 },
          measured: { width: 400, height: 800 },
        },
        ...tracks.flatMap((ids, track) =>
          ids.map((childId) => ({
            id: childId,
            type: 'note',
            parentId: id,
            position: { x: 0, y: 0 },
            data: { [field]: track },
            style: size,
            measured: size,
          })),
        ),
      ];
    }

    /** `nodes` with every Frame's children where its layout puts them. */
    function laidOut(nodes: Node[]): Node[] {
      let result = nodes;
      for (const candidate of nodes) {
        if (candidate.type !== 'frame') continue;
        const layout = solveStructuredFrameLayout(
          result,
          candidate.id,
          'compact',
        );
        if (!layout) throw new Error('Missing fixture layout');
        result = result.map((node) => ({
          ...node,
          position: layout.childPositions.get(node.id) ?? node.position,
        }));
      }
      return result;
    }

    const fixture = (...frames: Node[][]) =>
      laidOut(seedNodeOrder(frames.flat()));

    function find(nodes: Node[], id: string): Node {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`Missing ${id}`);
      return node;
    }

    function absolute(nodes: Node[], id: string) {
      const node = find(nodes, id);
      const parent = node.parentId ? find(nodes, node.parentId) : undefined;
      return {
        x: node.position.x + (parent?.position.x ?? 0),
        y: node.position.y + (parent?.position.y ?? 0),
      };
    }

    /** Reading order per track, from the children's own track keys. */
    function tracksOf(nodes: Node[], frameId: string) {
      const described = describeFrameLayout(nodes, frameId);
      return described && 'tracks' in described ? described.tracks : undefined;
    }

    /** Children of a Frame in the order they are laid out along the track. */
    const laidOutOrder = (nodes: Node[], frameId: string) =>
      nodes
        .filter((node) => node.parentId === frameId)
        .sort(
          (a, b) =>
            (a.data[field] as number) - (b.data[field] as number) ||
            a.position[along] - b.position[along],
        )
        .map((node) => node.id);

    /**
     * Drag `ids` together so that the first lands at the absolute point
     * `to`, and release over `frameId`. Returns what the release commits and
     * what the live preview showed just before it.
     */
    function drop(
      nodes: Node[],
      ids: string[],
      frameId: string,
      to: { x: number; y: number },
    ) {
      const lead = absolute(nodes, ids[0]);
      const delta = { x: to.x - lead.x, y: to.y - lead.y };
      const dragged = nodes.map((node) =>
        ids.includes(node.id)
          ? {
              ...node,
              position: {
                x: node.position.x + delta.x,
                y: node.position.y + delta.y,
              },
            }
          : node,
      );
      const pointer = { x: to.x + 20, y: to.y + 20 };
      const entering = find(nodes, ids[0]).parentId !== frameId;

      // The preview sees a node that is leaving its Frame as already out of
      // it, at the same place on the canvas.
      const origin = find(nodes, frameId).position;
      const local = (id: string) => {
        const at = absolute(dragged, id);
        return { id, x: at.x - origin.x, y: at.y - origin.y, ...size };
      };
      const live = dragged.map((node) =>
        entering && ids.includes(node.id)
          ? {
              ...node,
              parentId: undefined,
              position: absolute(dragged, node.id),
            }
          : node,
      );
      const framePoint = { x: pointer.x - origin.x, y: pointer.y - origin.y };
      const preview = describeStructuredDropZone(
        live,
        frameId,
        framePoint,
        axis,
        find(nodes, frameId).data.gridCount as number,
        local(ids[0]),
        {
          // The track under the pointer, picked as the canvas picks it: a
          // selection never opens a new track.
          target: resolveMasonryDrop(live, frameId, axis, framePoint, {
            allowInsert: false,
          }).target,
          companions: ids.slice(1).map(local),
        },
      );
      if (!preview) throw new Error('Missing drop preview');

      const resolution = resolveUiIntent(
        {
          type: 'NODE_DRAG_STOP',
          draggedNodeIds: ids,
          pointerFlowPosition: pointer,
          cachedDecisions: new Map(
            ids.map((id) => [
              id,
              entering
                ? { unframe: true, enterFrameId: frameId }
                : { unframe: false, enterFrameId: null },
            ]),
          ),
        },
        { nodes: dragged, edges: [] },
      );
      const committed = executeCanvasCommands(
        { source: 'ui', commands: resolution.commands },
        { nodes: dragged, edges: [], canvasId: 'canvas' },
      ).writeResult.nodes;
      return { committed, preview };
    }

    /** The release put every node where the preview drew it. */
    function expectPreviewAgreement(
      committed: Node[],
      preview: NonNullable<ReturnType<typeof describeStructuredDropZone>>,
    ) {
      expect(preview.placements?.length).toBeGreaterThan(1);
      for (const rect of [...(preview.placements ?? []), ...preview.reflow]) {
        expect(find(committed, rect.id).position, rect.id).toEqual({
          x: rect.x,
          y: rect.y,
        });
      }
    }

    /** A point between the leading edges of two laid-out children. */
    function between(nodes: Node[], first: string, second: string) {
      const a = absolute(nodes, first);
      const b = absolute(nodes, second);
      return { ...a, [along]: (a[along] + b[along]) / 2 } as {
        x: number;
        y: number;
      };
    }

    it('lands a selection dropped into another Frame as one block', () => {
      const nodes = fixture(
        frame('source', 0, [['a', 'spacer-1', 'spacer-2', 'b']]),
        frame('target', 1000, [['t1', 't2', 't3', 't4']]),
      );
      // `a` lands between t1 and t2; `b` keeps its offset, past t3.
      const { committed, preview } = drop(
        nodes,
        ['a', 'b'],
        'target',
        between(nodes, 't1', 't2'),
      );
      const expected = ['t1', 'a', 'b', 't2', 't3', 't4'];
      expect(tracksOf(committed, 'target')).toEqual([expected]);
      expect(laidOutOrder(committed, 'target')).toEqual(expected);
      expectPreviewAgreement(committed, preview);
    });

    it('lands a selection moved inside one Frame as one block', () => {
      const nodes = fixture(
        frame('target', 0, [['a', 't1', 'b', 't2', 't3', 't4']]),
      );
      // `a` lands between t2 and t3; `b` keeps its offset, past t3.
      const { committed, preview } = drop(
        nodes,
        ['a', 'b'],
        'target',
        between(nodes, 't2', 't3'),
      );
      const expected = ['t1', 't2', 'a', 'b', 't3', 't4'];
      expect(tracksOf(committed, 'target')).toEqual([expected]);
      expect(laidOutOrder(committed, 'target')).toEqual(expected);
      expectPreviewAgreement(committed, preview);
    });

    it('lands a whole track moved into its neighbour as one block', () => {
      // Emptying track 0 compacts the Frame, so the destination ends up
      // numbered 0 as well; that must not read as "stayed in its track".
      // The ids sort after the peers', as the keys of two tracks tie.
      const nodes = fixture(
        frame('target', 0, [
          ['u', 'v'],
          ['t1', 't2', 't3'],
        ]),
      );
      const { committed, preview } = drop(
        nodes,
        ['u', 'v'],
        'target',
        between(nodes, 't1', 't2'),
      );
      const expected = ['t1', 'u', 'v', 't2', 't3'];
      expect(tracksOf(committed, 'target')).toEqual([expected]);
      expect(laidOutOrder(committed, 'target')).toEqual(expected);
      expectPreviewAgreement(committed, preview);
    });

    it('keeps a whole track together when snapped onto a peer of its neighbour', () => {
      // Snapping can release the leading node exactly on a peer. That peer
      // has just been renumbered with its track, so it is placed by its
      // coordinate as well; the tie must not put it inside the block.
      const nodes = fixture(
        frame('target', 0, [
          ['u', 'v'],
          ['t1', 't2', 't3'],
        ]),
      );
      const { committed, preview } = drop(
        nodes,
        ['u', 'v'],
        'target',
        absolute(nodes, 't1'),
      );
      const expected = ['t1', 'u', 'v', 't2', 't3'];
      expect(tracksOf(committed, 'target')).toEqual([expected]);
      expect(laidOutOrder(committed, 'target')).toEqual(expected);
      expectPreviewAgreement(committed, preview);
    });

    it('leaves a nudged non-adjacent selection where it was', () => {
      const ids = ['a', 't1', 'b', 't2'];
      const nodes = fixture(frame('target', 0, [ids]));
      const start = absolute(nodes, 'a');
      const { committed, preview } = drop(nodes, ['a', 'b'], 'target', {
        ...start,
        [along]: start[along] + 5,
      });
      expect(tracksOf(committed, 'target')).toEqual([ids]);
      for (const id of ids) {
        expect(find(committed, id).position).toEqual(find(nodes, id).position);
      }
      expectPreviewAgreement(committed, preview);
    });

    // Two ways a Frame comes to have no stored list: it was laid out before
    // reading order was stored, or it has only just become this layout.
    it.each(['stored without an order', 'just given this layout'] as const)(
      'leaves a nudged selection alone in a Frame %s',
      (origin) => {
        const ids = ['a', 't1', 'b', 't2'];
        const switched = origin === 'just given this layout';
        const raw: Node[] = [
          {
            id: 'target',
            type: 'frame',
            position: { x: 0, y: 0 },
            data: switched
              ? { sizing: 'hug' }
              : { layoutMode: axis, gridCount: 1, sizing: 'hug' },
            style: { width: 400, height: 800 },
            measured: { width: 400, height: 800 },
          },
          ...ids.map((id, index) => ({
            id,
            type: 'note',
            parentId: 'target',
            // Geometry is the only order such a Frame has.
            position: { x: 20, y: 80, [along]: 80 + index * 200 },
            data: switched ? {} : { [field]: 0 },
            style: size,
            measured: size,
          })),
        ];
        const nodes = switched
          ? executeCanvasCommands(
              {
                source: 'ui',
                commands: [
                  {
                    type: 'SET_FRAME_LAYOUT',
                    frameId: 'target' as CanvasNodeId,
                    mode: axis,
                    gridCount: 1,
                  },
                ],
              },
              { nodes: raw, edges: [], canvasId: 'canvas' },
            ).writeResult.nodes
          : laidOut(seedNodeOrder(raw));
        expect(tracksOf(nodes, 'target')).toEqual([ids]);

        const start = absolute(nodes, 'a');
        const { committed } = drop(nodes, ['a', 'b'], 'target', {
          ...start,
          [along]: start[along] + 5,
        });
        expect(tracksOf(committed, 'target')).toEqual([ids]);
        for (const id of ids) {
          expect(find(committed, id).position).toEqual(
            find(nodes, id).position,
          );
        }
      },
    );
  },
);
