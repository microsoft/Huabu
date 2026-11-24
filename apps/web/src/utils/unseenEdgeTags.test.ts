// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  edgeTags,
  unseenPieces,
  viewportOnPiece,
  type EdgeTagConfig,
  type MarkedNode,
} from './unseenEdgeTags';

const config: EdgeTagConfig = {
  clusterGap: 200,
  maxTags: 3,
  edgePadding: 10,
  topClearance: 0,
  topLeftClearance: 0,
  topRightClearance: 0,
  bottomLeftClearance: 0,
  bottomRightClearance: 0,
  bottomToolbarWidth: 0,
  bottomClearance: 60,
  dotSize: 20,
  pointerSize: 10,
  pointerGap: 3,
  tagGap: 10,
  flyPadding: 50,
  flyDurationMs: 0,
};
/** A 1000 × 800 canvas with a 200 px panel over its left side. */
const area = { x: 200, y: 0, width: 800, height: 800 };
const viewport = { x: 0, y: 0, zoom: 1 };
const node = (
  id: string,
  x: number,
  y: number,
  kind: 'create' | 'update' = 'create',
): MarkedNode => ({ id, rect: { x, y, width: 100, height: 100 }, kind });

describe('unseenPieces', () => {
  it('joins nodes that are near one another, chained, in reading order', () => {
    const pieces = unseenPieces(
      [
        node('c', 400, 0),
        node('a', 0, 0),
        node('b', 200, 0),
        node('z', 900, 0),
      ],
      200,
    );
    expect(pieces.map((piece) => piece.map((entry) => entry.id))).toEqual([
      ['a', 'b', 'c'],
      ['z'],
    ]);
  });
});

describe('edgeTags', () => {
  it('shows no tag for a piece with any of it in view', () => {
    // The second node is out of view, but it is one piece with the first.
    const tags = edgeTags(
      [node('in', 900, 300), node('out', 1100, 300)],
      viewport,
      area,
      config,
    );
    expect(tags).toEqual([]);
  });

  it('counts a node under a side panel as out of view', () => {
    const [tag] = edgeTags([node('n', 50, 350)], viewport, area, config);
    expect(tag).toMatchObject({ edge: 'left', x: 210, y: 400 });
  });

  it('puts the tag where the line to the piece meets the edge', () => {
    // The inner box is 210..990 by 10..790; its centre is (600, 400).
    const [right] = edgeTags([node('n', 3000, 350)], viewport, area, config);
    expect(right).toMatchObject({ edge: 'right', x: 990, y: 400 });
    const [above] = edgeTags([node('n', 550, -2000)], viewport, area, config);
    expect(above).toMatchObject({ edge: 'top', x: 600, y: 10 });
  });

  it('sits against the bottom edge, clear of the corners', () => {
    const [below] = edgeTags([node('n', 3150, 3000)], viewport, area, config);
    expect(below).toMatchObject({ edge: 'bottom', y: 790 });
    // Centred on its anchor, a dot 20 wide must stay within 210..990.
    expect(below.x).toBe(980);
  });

  it('keeps out of what sits along the bottom only', () => {
    const taken = {
      ...config,
      bottomLeftClearance: 90,
      bottomToolbarWidth: 300,
    };
    // Straight below is the toolbar, 450..750: the tag goes beside it, on
    // the side the piece leans to.
    const [beside] = edgeTags([node('n', 600, 3000)], viewport, area, taken);
    expect(beside).toMatchObject({ edge: 'bottom', x: 760, y: 790 });
    // Below and far to the left: pushed clear of the left corner.
    const [left] = edgeTags([node('n', -1750, 3000)], viewport, area, taken);
    expect(left).toMatchObject({ edge: 'bottom', x: 210 + 90 + 10, y: 790 });
    // To the right and far down: on the side edge, above the bottom corner.
    const [side] = edgeTags([node('n', 9000, 8200)], viewport, area, taken);
    expect(side).toMatchObject({ edge: 'right', x: 990, y: 790 - 60 - 10 });
  });

  it('keeps out of the top corners only', () => {
    const corners = {
      ...config,
      topClearance: 50,
      topLeftClearance: 150,
      topRightClearance: 80,
    };
    // Straight above: against the top edge itself, not below the corners.
    const [above] = edgeTags([node('n', 550, -2000)], viewport, area, corners);
    expect(above).toMatchObject({ edge: 'top', x: 600, y: 10 });
    // Above and far to the left: pushed clear of the left corner.
    const [left] = edgeTags([node('n', -1400, -2000)], viewport, area, corners);
    expect(left).toMatchObject({ edge: 'top', x: 210 + 150 + 10, y: 10 });
    // To the right and far up: on the side edge, below the corner.
    const [side] = edgeTags([node('n', 9000, -7400)], viewport, area, corners);
    expect(side).toMatchObject({ edge: 'right', x: 990, y: 10 + 50 + 10 });
  });

  it('follows the viewport', () => {
    const moved = { x: -2000, y: 0, zoom: 0.5 };
    // On screen the node is at -1000..-950, left of the view.
    const [tag] = edgeTags([node('n', 2000, 700)], moved, area, config);
    expect(tag.edge).toBe('left');
    expect(edgeTags([node('n', 5000, 700)], moved, area, config)).toEqual([]);
  });

  it('shows the nearest pieces when there are more than it may show', () => {
    const tags = edgeTags(
      [
        node('far', 9000, 300),
        node('near', 1500, 300),
        node('up', 500, -1200),
        node('down', 500, 2400),
      ],
      viewport,
      area,
      { ...config, maxTags: 2 },
    );
    expect(tags.map((tag) => tag.key)).toEqual(['near', 'up']);
  });

  it('moves tags on one edge apart', () => {
    const tags = edgeTags(
      [node('a', 3000, 300), node('b', 6000, 330), node('c', 9000, 360)],
      viewport,
      area,
      { ...config, clusterGap: 100 },
    );
    const ys = tags.map((tag) => tag.y).sort((a, b) => a - b);
    expect(tags.every((tag) => tag.edge === 'right')).toBe(true);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(30);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(30);
  });

  it('names a piece by its first node in reading order', () => {
    const [tag] = edgeTags(
      [node('second', 3200, 300), node('first', 3000, 300)],
      viewport,
      area,
      config,
    );
    expect(tag.key).toBe('first');
    expect(tag.nodes.map((entry) => entry.id)).toEqual(['first', 'second']);
  });
});

describe('edgeTags for conversations', () => {
  const talk = (
    id: string,
    x: number,
    y: number,
    attention: NonNullable<MarkedNode['attention']>,
  ): MarkedNode => ({
    id,
    rect: { x, y, width: 100, height: 100 },
    attention,
  });

  it('joins a finished conversation to the content beside it', () => {
    const [tag, ...rest] = edgeTags(
      [node('made', 3150, 300), talk('talk', 3000, 300, 'done')],
      viewport,
      area,
      config,
    );
    expect(rest).toEqual([]);
    expect(tag.attention).toBe('done');
    expect(tag.nodes.map((entry) => entry.id)).toEqual(['talk', 'made']);
  });

  it('keeps one that waits or failed apart from the content beside it', () => {
    const tags = edgeTags(
      [
        node('made', 3150, 300),
        talk('failed', 3000, 300, 'error'),
        talk('waiting', 3300, 300, 'approval'),
      ],
      viewport,
      area,
      config,
    );
    expect(tags.map((tag) => [tag.key, tag.attention])).toEqual([
      ['waiting', 'approval'],
      ['failed', 'error'],
      ['made', 'done'],
    ]);
  });

  it('puts what waits for the person first, then what failed', () => {
    const tags = edgeTags(
      [
        node('near', 1500, 300),
        talk('failed', 5000, 300, 'error'),
        talk('waiting', 9000, 300, 'approval'),
      ],
      viewport,
      area,
      { ...config, maxTags: 2 },
    );
    expect(tags.map((tag) => [tag.key, tag.attention])).toEqual([
      ['waiting', 'approval'],
      ['failed', 'error'],
    ]);
  });
});

describe('viewportOnPiece', () => {
  it('centres the piece in the visible canvas at the same zoom', () => {
    expect(
      viewportOnPiece([node('n', 3000, 3000)], viewport, area, 50),
    ).toEqual({ x: 600 - 3050, y: 400 - 3050, zoom: 1 });
  });

  it('zooms out just enough for a piece that does not fit', () => {
    const wide = [node('a', 0, 0), node('b', 1300, 0)];
    const next = viewportOnPiece(wide, viewport, area, 50);
    // 1400 wide into 700 of room.
    expect(next.zoom).toBe(0.5);
    expect(next.x).toBe(600 - 700 * 0.5);
  });
});
