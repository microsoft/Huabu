// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Space presence: which pages have a Space open and what each is pointing at,
 * selecting, dragging or editing.
 *
 * Held in memory only, per Space, keyed by page id. Nothing here touches the
 * Space record, its version, the delta log or the Canvas Sync publisher that
 * Agents and conversation observers listen to; presence has its own
 * subscribers, which the Canvas Sync SSE route forwards on the same stream.
 *
 * A page leaves when it says so, when its last stream closes, or when it has
 * not reported for `expiryMs`, so a crashed page leaves no marker behind.
 */

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import type {
  CanvasPresenceEventData,
  CanvasPresencePage,
  CanvasPresenceReportBody,
} from '@huabu/shared';

type Listener = (event: CanvasPresenceEventData) => void;

interface Entry {
  page: CanvasPresencePage;
  lastSeen: number;
  /** Start of the current one-second rate window and reports counted in it. */
  windowStart: number;
  windowCount: number;
}

interface Subscriber {
  pageId: string | undefined;
  listener: Listener;
}

interface SpacePresence {
  pages: Map<string, Entry>;
  subscribers: Set<Subscriber>;
}

export type PresenceReportResult = 'accepted' | 'rate-limited' | 'full';

export interface CanvasPresenceHubOptions {
  now?: () => number;
  expiryMs?: number;
  maxPagesPerSpace?: number;
  maxReportsPerSecond?: number;
}

export interface CanvasPresenceHub {
  /** Merge a page's report into its presence and relay it to the others. */
  report(
    spaceKey: string,
    body: CanvasPresenceReportBody,
  ): PresenceReportResult;
  /** Drop a page and tell the others. */
  leave(spaceKey: string, pageId: string): void;
  /**
   * Receive the presence of every page but `pageId`. Closing the last
   * subscription of a page drops that page.
   */
  subscribe(
    spaceKey: string,
    pageId: string | undefined,
    listener: Listener,
  ): () => void;
  /** Pages currently present, without `exceptPageId`. */
  snapshot(spaceKey: string, exceptPageId?: string): CanvasPresencePage[];
  /** Drop every page that has not reported within `expiryMs`. */
  sweep(): void;
  /** Stop the expiry timer and forget everything. */
  reset(): void;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createCanvasPresenceHub(
  options: CanvasPresenceHubOptions = {},
): CanvasPresenceHub {
  const now = options.now ?? Date.now;
  const expiryMs = options.expiryMs ?? CANVAS_PRESENCE_LIMITS.expiryMs;
  const maxPages =
    options.maxPagesPerSpace ?? CANVAS_PRESENCE_LIMITS.maxPagesPerSpace;
  const maxReports =
    options.maxReportsPerSecond ?? CANVAS_PRESENCE_LIMITS.maxReportsPerSecond;
  const spaces = new Map<string, SpacePresence>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const spaceFor = (spaceKey: string): SpacePresence => {
    let space = spaces.get(spaceKey);
    if (!space) {
      space = { pages: new Map(), subscribers: new Set() };
      spaces.set(spaceKey, space);
    }
    return space;
  };

  const prune = (spaceKey: string, space: SpacePresence): void => {
    if (space.pages.size === 0 && space.subscribers.size === 0)
      spaces.delete(spaceKey);
    if (timer && ![...spaces.values()].some((entry) => entry.pages.size > 0)) {
      clearInterval(timer);
      timer = null;
    }
  };

  const relay = (
    space: SpacePresence,
    fromPageId: string,
    event: CanvasPresenceEventData,
  ): void => {
    for (const subscriber of space.subscribers) {
      if (subscriber.pageId === fromPageId) continue;
      try {
        subscriber.listener(event);
      } catch {
        /* one failing stream must not stall the others */
      }
    }
  };

  const remove = (
    spaceKey: string,
    space: SpacePresence,
    pageId: string,
  ): void => {
    if (!space.pages.delete(pageId)) return;
    relay(space, pageId, { op: 'leave', pageId });
    prune(spaceKey, space);
  };

  const sweep = (): void => {
    const deadline = now() - expiryMs;
    for (const [spaceKey, space] of spaces) {
      for (const [pageId, entry] of space.pages) {
        if (entry.lastSeen <= deadline) remove(spaceKey, space, pageId);
      }
    }
  };

  /** Lowest colour no present page uses; the least used one when all are. */
  const pickColor = (space: SpacePresence): number => {
    const used = new Array<number>(CANVAS_PRESENCE_LIMITS.colorCount).fill(0);
    for (const entry of space.pages.values()) used[entry.page.colorIndex] += 1;
    return used.indexOf(Math.min(...used));
  };

  /** Merge `report` into `entry` and relay what changed. */
  const apply = (
    space: SpacePresence,
    entry: Entry,
    report: CanvasPresenceReportBody,
    at: number,
    isNew: boolean,
  ): void => {
    entry.windowCount += 1;
    entry.lastSeen = at;
    const page = entry.page;
    // A new page is announced whole, whatever its first report carried.
    let changed = isNew;
    if (report.label !== undefined && report.label !== page.label) {
      page.label = report.label;
      changed = true;
    }
    if (
      report.displayName !== undefined &&
      report.displayName !== page.displayName
    ) {
      page.displayName = report.displayName;
      changed = true;
    }
    for (const key of [
      'selectedNodeIds',
      'draggingNodeIds',
      'editingNodeIds',
    ] as const) {
      const ids = report[key];
      if (ids === undefined || sameIds(ids, page[key])) continue;
      page[key] = [...ids];
      changed = true;
    }
    const pointer = report.pointer;
    const pointerChanged =
      pointer !== undefined &&
      (pointer?.x !== page.pointer?.x || pointer?.y !== page.pointer?.y);
    if (pointerChanged) page.pointer = pointer ? { ...pointer } : null;
    if (changed) {
      relay(space, page.pageId, { op: 'update', page: clonePage(page) });
    } else if (pointerChanged) {
      relay(space, page.pageId, {
        op: 'pointer',
        pageId: page.pageId,
        pointer: page.pointer,
      });
    }
  };

  const startTimer = (): void => {
    if (timer) return;
    timer = setInterval(sweep, Math.max(250, Math.floor(expiryMs / 6)));
    timer.unref?.();
  };

  return {
    report(spaceKey, body) {
      const space = spaceFor(spaceKey);
      const at = now();
      const existing = space.pages.get(body.pageId);
      if (existing) {
        if (at - existing.windowStart >= 1_000) {
          existing.windowStart = at;
          existing.windowCount = 0;
        }
        if (existing.windowCount >= maxReports) return 'rate-limited';
        apply(space, existing, body, at, false);
        return 'accepted';
      }
      if (space.pages.size >= maxPages) {
        prune(spaceKey, space);
        return 'full';
      }
      const entry: Entry = {
        page: {
          pageId: body.pageId,
          colorIndex: pickColor(space),
          label: '',
          pointer: null,
          selectedNodeIds: [],
          draggingNodeIds: [],
          editingNodeIds: [],
        },
        lastSeen: at,
        windowStart: at,
        windowCount: 0,
      };
      space.pages.set(body.pageId, entry);
      apply(space, entry, body, at, true);
      startTimer();
      return 'accepted';
    },

    leave(spaceKey, pageId) {
      const space = spaces.get(spaceKey);
      if (space) remove(spaceKey, space, pageId);
    },

    subscribe(spaceKey, pageId, listener) {
      const space = spaceFor(spaceKey);
      const subscriber: Subscriber = { pageId, listener };
      space.subscribers.add(subscriber);
      return () => {
        if (!space.subscribers.delete(subscriber)) return;
        const stillConnected =
          pageId !== undefined &&
          [...space.subscribers].some((other) => other.pageId === pageId);
        if (pageId !== undefined && !stillConnected)
          remove(spaceKey, space, pageId);
        prune(spaceKey, space);
      };
    },

    snapshot(spaceKey, exceptPageId) {
      const space = spaces.get(spaceKey);
      if (!space) return [];
      return [...space.pages.values()]
        .filter((entry) => entry.page.pageId !== exceptPageId)
        .map((entry) => clonePage(entry.page));
    },

    sweep,

    reset() {
      if (timer) clearInterval(timer);
      timer = null;
      spaces.clear();
    },
  };
}

function clonePage(page: CanvasPresencePage): CanvasPresencePage {
  return {
    ...page,
    pointer: page.pointer ? { ...page.pointer } : null,
    selectedNodeIds: [...page.selectedNodeIds],
    draggingNodeIds: [...page.draggingNodeIds],
    editingNodeIds: [...page.editingNodeIds],
  };
}

/** The process-wide hub used by the routes. */
export const canvasPresence = createCanvasPresenceHub();
