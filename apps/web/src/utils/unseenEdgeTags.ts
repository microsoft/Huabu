// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Where the tags go that point, from the edge of the visible canvas, at the
 * marked nodes out of view. Pure geometry: the layer that draws them reads
 * the stores and the DOM, and hands the numbers in.
 */

import {
  findClusters,
  sortByReadingOrder,
  type CanvasViewport,
  type Rect,
} from '@huabu/shared';

import { ATTENTION_RANK, type AttentionKind } from '@/utils/attention';

/** The numbers the tags are laid out by. See `edgeTagConfig.ts`. */
export interface EdgeTagConfig {
  clusterGap: number;
  maxTags: number;
  edgePadding: number;
  topClearance: number;
  topLeftClearance: number;
  topRightClearance: number;
  bottomLeftClearance: number;
  bottomRightClearance: number;
  bottomToolbarWidth: number;
  bottomClearance: number;
  dotSize: number;
  pointerSize: number;
  pointerGap: number;
  tagGap: number;
  flyPadding: number;
  flyDurationMs: number;
}

interface NodeBox {
  id: string;
  /** Its box in canvas units, absolute. */
  rect: Rect;
  label?: string;
  type?: string;
}

/**
 * What a tag may point at a node for: content that carries an unseen mark,
 * or a conversation's own node when the conversation holds something unseen.
 */
export type MarkedAs =
  | {
      /** `create` when an Agent made it, `update` when one changed it. */
      kind: 'create' | 'update';
      attention?: undefined;
    }
  | {
      /** What the conversation holds unseen. */
      attention: AttentionKind;
    };

/** A node a tag may point at. */
export type MarkedNode = NodeBox & MarkedAs;

export type TagEdge = 'left' | 'right' | 'top' | 'bottom';

/** One tag: the piece it points at and where it sits. */
export interface EdgeTag {
  /** Stable while the piece keeps its first node. */
  key: string;
  /** The piece's nodes, in reading order. */
  nodes: MarkedNode[];
  /** What the tag is about: `done` for content an Agent made or changed. */
  attention: AttentionKind;
  /** The edge of the visible canvas the tag sits against. */
  edge: TagEdge;
  /** The point on that edge the tag is anchored to, in screen px. */
  x: number;
  y: number;
}

/** What a tag for a node is about: `done` for content. */
const about = (node: MarkedNode): AttentionKind => node.attention ?? 'done';

/**
 * The nodes grouped into pieces, each in reading order. Nodes close to one
 * another are one piece when a tag for them would say the same thing: a
 * finished conversation joins the content beside it, whichever conversation
 * made that, while one that waits for approval or failed stays apart from
 * what only reports.
 */
export function unseenPieces(
  nodes: readonly MarkedNode[],
  clusterGap: number,
): MarkedNode[][] {
  return (['approval', 'error', 'done'] as const).flatMap((kind) =>
    findClusters(
      nodes.filter((node) => about(node) === kind),
      clusterGap,
    ).map(sortByReadingOrder),
  );
}

const union = (rects: readonly Rect[]): Rect => {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const clamp = (value: number, min: number, max: number): number =>
  min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);

/**
 * Move values apart, keeping their order, until neighbours are at least
 * `step` apart and all lie within `min`..`max` where that is possible.
 */
function spread(
  values: number[],
  step: number,
  min: number,
  max: number,
): number[] {
  const order = values.map((_, index) => index);
  order.sort((a, b) => values[a] - values[b]);
  const result = [...values];
  for (let i = 1; i < order.length; i++)
    result[order[i]] = Math.max(result[order[i]], result[order[i - 1]] + step);
  const last = order.length - 1;
  if (last >= 0 && result[order[last]] > max) {
    result[order[last]] = max;
    for (let i = last - 1; i >= 0; i--)
      result[order[i]] = Math.min(
        result[order[i]],
        result[order[i + 1]] - step,
      );
  }
  return result.map((value) => Math.max(value, min));
}

/**
 * The tags to show: one for each piece that lies wholly outside the visible
 * canvas, at most `config.maxTags` of them: first what waits for the person,
 * then what failed, then the rest, the nearest first within each.
 *
 * @param area The visible canvas within its container, in screen px.
 */
export function edgeTags(
  nodes: readonly MarkedNode[],
  viewport: CanvasViewport,
  area: Rect,
  config: EdgeTagConfig,
): EdgeTag[] {
  const left = area.x + config.edgePadding;
  const right = area.x + area.width - config.edgePadding;
  const top = area.y + config.edgePadding;
  const bottom = area.y + area.height - config.edgePadding;
  if (right <= left || bottom <= top || viewport.zoom <= 0) return [];
  // Where along each edge a tag's centre may lie. Only parts of the top and
  // bottom are taken, by what sits there: the Space title and the panel
  // buttons in the top corners; the zoom menu, the toolbar and the minimap
  // along the bottom. A tag keeps out of those sideways, and a tag on a
  // side edge keeps above and below them.
  const half = config.dotSize / 2;
  const middle = (left + right) / 2;
  const side: [number, number][] = [
    [top + config.topClearance + half, bottom - config.bottomClearance - half],
  ];
  const stretches: Record<TagEdge, [number, number][]> = {
    top: [
      [
        left + config.topLeftClearance + half,
        right - config.topRightClearance - half,
      ],
    ],
    bottom: [
      [
        left + config.bottomLeftClearance + half,
        middle - config.bottomToolbarWidth / 2 - half,
      ],
      [
        middle + config.bottomToolbarWidth / 2 + half,
        right - config.bottomRightClearance - half,
      ],
    ],
    left: side,
    right: side,
  };
  /** The stretch of an edge nearest a point along it, and the point in it. */
  const settle = (edge: TagEdge, along: number) => {
    let best = { stretch: 0, along: Infinity, off: Infinity };
    stretches[edge].forEach(([from, to], stretch) => {
      const within = clamp(along, from, to);
      // A stretch too short to hold a tag is the last resort.
      const off = Math.abs(within - along) + (from > to ? 1e6 : 0);
      if (off < best.off) best = { stretch, along: within, off };
    });
    return best;
  };
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  const onScreen = (rect: Rect): Rect => ({
    x: rect.x * viewport.zoom + viewport.x,
    y: rect.y * viewport.zoom + viewport.y,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom,
  });

  const away = unseenPieces(nodes, config.clusterGap).flatMap((piece) => {
    const rects = piece.map((node) => onScreen(node.rect));
    // A piece with any of it in view already shows its marks.
    if (rects.some((rect) => intersects(rect, area))) return [];
    const bounds = union(rects);
    const distance = Math.hypot(
      Math.max(bounds.x - centreX, 0, centreX - (bounds.x + bounds.width)),
      Math.max(bounds.y - centreY, 0, centreY - (bounds.y + bounds.height)),
    );
    return [{ piece, bounds, distance, attention: about(piece[0]) }];
  });
  away.sort(
    (a, b) =>
      ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] ||
      a.distance - b.distance,
  );

  const placed = away
    .slice(0, config.maxTags)
    .map(({ piece, bounds, attention }) => {
      const dx = bounds.x + bounds.width / 2 - centreX;
      const dy = bounds.y + bounds.height / 2 - centreY;
      // How far along the line to the piece each pair of edges is reached.
      const untilSide = dx === 0 ? Infinity : (right - left) / 2 / Math.abs(dx);
      const untilEnd = dy === 0 ? Infinity : (bottom - top) / 2 / Math.abs(dy);
      const sideways = untilSide <= untilEnd;
      const reach = Math.min(untilSide, untilEnd, 1);
      const edge: TagEdge = sideways
        ? dx > 0
          ? 'right'
          : 'left'
        : dy > 0
          ? 'bottom'
          : 'top';
      const { stretch, along } = settle(
        edge,
        sideways ? centreY + dy * reach : centreX + dx * reach,
      );
      const tag: EdgeTag = {
        key: piece[0].id,
        nodes: piece,
        attention,
        edge,
        // The tag hangs from this point: centred on it along the edge.
        x: sideways ? (dx > 0 ? right : left) : along,
        y: sideways ? along : dy > 0 ? bottom : top,
      };
      return { tag, stretch };
    });

  // Tags on the same stretch of an edge must not lie on top of one another.
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const sideways = edge === 'left' || edge === 'right';
    stretches[edge].forEach(([from, to], stretch) => {
      const here = placed
        .filter((entry) => entry.tag.edge === edge && entry.stretch === stretch)
        .map((entry) => entry.tag);
      if (here.length < 2) return;
      const apart = spread(
        here.map((tag) => (sideways ? tag.y : tag.x)),
        config.dotSize + config.tagGap,
        from,
        to,
      );
      here.forEach((tag, index) => {
        if (sideways) tag.y = apart[index];
        else tag.x = apart[index];
      });
    });
  }
  return placed.map((entry) => entry.tag);
}

/**
 * The viewport that puts a piece in the middle of the visible canvas. The
 * zoom is kept when the piece fits at it, and lowered just enough when not.
 */
export function viewportOnPiece(
  nodes: readonly MarkedNode[],
  viewport: CanvasViewport,
  area: Rect,
  padding: number,
): CanvasViewport {
  const bounds = union(nodes.map((node) => node.rect));
  const zoom = Math.min(
    viewport.zoom,
    Math.max(area.width - padding * 2, 1) / Math.max(bounds.width, 1),
    Math.max(area.height - padding * 2, 1) / Math.max(bounds.height, 1),
  );
  return {
    x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}
