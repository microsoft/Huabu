// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { EdgeTagConfig } from '@/utils/unseenEdgeTags';

/**
 * Every number the edge tags are laid out by, in one place so that they can
 * be tuned by eye: change a value here and the running dev page follows.
 */
export const EDGE_TAG_CONFIG: EdgeTagConfig = {
  /**
   * Marked nodes whose edges are closer than this, in canvas units, count as
   * one piece and share a tag. Chained: A near B and B near C is one piece.
   */
  clusterGap: 200,
  /** The most tags shown at once; the pieces nearest the view win. */
  maxTags: 3,
  /** Space between a tag and the edge of the visible canvas, in screen px. */
  edgePadding: 12,
  /**
   * The top corners are taken: the Space title on the left, the panel
   * buttons on the right. A tag on a side edge stays this far below the top,
   * in screen px.
   */
  topClearance: 48,
  /** How far a tag on the top edge stays from the left end, for the title. */
  topLeftClearance: 180,
  /** How far a tag on the top edge stays from the right end, for the buttons. */
  topRightClearance: 96,
  /**
   * The bottom is taken in parts: the zoom menu on the left, the toolbar in
   * the middle, the minimap on the right when it is shown. A tag on a side
   * edge stays this far above the bottom, in screen px.
   */
  bottomClearance: 64,
  /** How far a tag on the bottom edge stays from the left end, for the zoom menu. */
  bottomLeftClearance: 96,
  /** How far a tag on the bottom edge stays from the right end; 0 with no minimap. */
  bottomRightClearance: 0,
  /** The width kept free in the middle of the bottom edge, for the toolbar. */
  bottomToolbarWidth: 470,
  /** The diameter of a tag's dot, in screen px. The number in it is sized from it. */
  dotSize: 22,
  /** How broad the pointer beside the dot is, in screen px; its length follows. */
  pointerSize: 9,
  /** The space between the dot's halo and the pointer, in screen px. */
  pointerGap: 4,
  /**
   * The least space between two dots on the same edge, in screen px. Their
   * halos reach 5 px past them, so less than 10 lets the halos touch.
   */
  tagGap: 16,
  /** Space left around a piece once the canvas has gone to it, in screen px. */
  flyPadding: 80,
  /** How long going to a piece takes, in ms. */
  flyDurationMs: 400,
};
