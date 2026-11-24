// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** What the Layers panel does with a pending locate request. */
export type LayerLocateAction =
  /** The row is in the rendered tree; the tree scrolls to it. */
  | 'tree'
  /** Search or filters hide the row and Layers is the only locator: clear them. */
  | 'clear-filters'
  /** Nothing can be shown; discard the request so it never fires later. */
  | 'drop';

export function resolveLayerLocate(state: {
  /** The request came with the Canvas hidden, so Layers must show the node. */
  force: boolean;
  /** The node has a row in the tree as currently rendered. */
  inRenderedTree: boolean;
  /** The node exists in this Space's layer list at all. */
  exists: boolean;
  isSearchActive: boolean;
  isFilterActive: boolean;
}): LayerLocateAction {
  if (state.inRenderedTree) return 'tree';
  const hiddenByUser = state.isSearchActive || state.isFilterActive;
  // Without `force` the Canvas already shows the node, so the user's search
  // and filters win. Rows hidden by default (Sketches) cannot be revealed.
  return state.force && state.exists && hiddenByUser ? 'clear-filters' : 'drop';
}
