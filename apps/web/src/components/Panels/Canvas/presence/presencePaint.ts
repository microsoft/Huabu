// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { RemotePresencePage } from '@/store/canvasPresence/canvasPresenceStore';

/** What another page is doing with a node, strongest first. */
export type PresenceActivity = 'editing' | 'dragging' | 'selected';

export interface RemoteNodeOutline {
  pageId: string;
  nodeId: string;
  activity: PresenceActivity;
  colorIndex: number;
  /** Order of the page among those present; separates stacked outlines. */
  slot: number;
  /** Whether this outline carries the page's label. */
  labelled: boolean;
}

/**
 * Presence colours are the node accent palette, so a marker looks like part
 * of the app in both themes. White and grey do not read as a colour, and
 * blue is this page's own selection, so those three are left out. The order
 * puts unlike hues next to each other, since pages take the lowest free one.
 *
 * Each entry is the accent's existing foreground token: a marker is a thin
 * outline, a small arrow and a label with `text-fg-inverse` on it, so it
 * needs the palette's text-strength colour, not a tint. `text-fg` is the
 * stronger of the two in the light theme; amber's is too light to carry the
 * label text there, so amber uses `fg`. In the dark theme both are the same.
 */
export const PRESENCE_COLOR_TOKENS = [
  '--accent-teal-text-fg',
  '--accent-orange-text-fg',
  '--accent-purple-text-fg',
  '--accent-green-text-fg',
  '--accent-red-text-fg',
  '--accent-amber-fg',
] as const;

/** The accent token of a page's colour index. */
export function presenceColor(colorIndex: number): string {
  const count = PRESENCE_COLOR_TOKENS.length;
  const slot = ((Math.trunc(colorIndex) % count) + count) % count;
  return `var(${PRESENCE_COLOR_TOKENS[slot]})`;
}

/**
 * One outline per (page, node), with the strongest activity when a node is in
 * several of the page's lists. Every node being edited or dragged is
 * labelled; of the merely selected ones only the first, so a large remote
 * selection is not a wall of labels.
 */
export function remoteNodeOutlines(
  pages: Record<string, RemotePresencePage>,
): RemoteNodeOutline[] {
  const outlines: RemoteNodeOutline[] = [];
  const ordered = Object.values(pages).sort((a, b) =>
    a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0,
  );
  ordered.forEach((page, slot) => {
    const activities = new Map<string, PresenceActivity>();
    const lists: Array<[PresenceActivity, readonly string[]]> = [
      ['editing', page.editingNodeIds],
      ['dragging', page.draggingNodeIds],
      ['selected', page.selectedNodeIds],
    ];
    for (const [activity, ids] of lists) {
      for (const id of ids)
        if (!activities.has(id)) activities.set(id, activity);
    }
    let labelledSelection = false;
    for (const [nodeId, activity] of activities) {
      const labelled = activity !== 'selected' || !labelledSelection;
      if (activity === 'selected') labelledSelection = true;
      outlines.push({
        pageId: page.pageId,
        nodeId,
        activity,
        colorIndex: page.colorIndex,
        slot,
        labelled,
      });
    }
  });
  return outlines;
}
