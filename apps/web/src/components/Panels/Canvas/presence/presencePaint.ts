// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

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

/** The `--color-presence-*` token of a page's colour index. */
export function presenceColor(colorIndex: number): string {
  const count = CANVAS_PRESENCE_LIMITS.colorCount;
  const slot = ((Math.trunc(colorIndex) % count) + count) % count;
  return `var(--color-presence-${slot + 1})`;
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
