// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Space presence: which pages have a Space open and what each is pointing at,
 * selecting, dragging or editing.
 *
 * Held in memory only, per Space. Nothing here touches the Space record, its
 * version, the delta log or the Canvas Sync publisher that Agents and
 * conversation observers listen to; presence has its own subscribers, which
 * the Canvas Sync SSE route forwards on the same stream.
 *
 * **Who owns an entry.** A page chooses its own page id, so the id alone
 * proves nothing. An entry is keyed by the authenticated principal together
 * with the page id: a caller can create, change, rate-limit and remove only
 * entries of its own principal, whatever page id it quotes. To a viewer of
 * another principal a page is shown under an id the server assigned
 * (`publicId`), so page ids are not learned across principals either, and
 * with the name the identity provider gave its principal — never one the page
 * sent. A viewer of the same principal (the person's other tabs and devices)
 * sees the page id as reported and no name.
 *
 * A page leaves when it says so, when its last stream closes, or when it has
 * not reported for `expiryMs`, so a crashed page leaves no marker behind.
 */

import { randomUUID } from 'node:crypto';

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import { ANONYMOUS_PRINCIPAL } from './caller-principal.js';

import type {
  CanvasPresenceEventData,
  CanvasPresencePage,
  CanvasPresenceReportBody,
} from '@huabu/shared';

type Listener = (event: CanvasPresenceEventData) => void;

/** The authenticated caller of a presence request. */
export interface PresenceCaller {
  principalId: string;
  /** The principal's name as the identity provider gives it. */
  displayName?: string;
  /**
   * Whether the caller may write the Space. Only then can it hold the edit
   * lock: `editingNodeIds` of a caller without it are not taken.
   */
  mayHoldEditLock?: boolean;
}

const ANONYMOUS_CALLER: PresenceCaller = {
  principalId: ANONYMOUS_PRINCIPAL,
};

/** One-second budget of reports. */
interface RateWindow {
  windowStart: number;
  windowCount: number;
}

interface Entry extends RateWindow {
  principalId: string;
  /** The id the page reports with; shown to its own principal only. */
  pageId: string;
  /** The id other principals see the page under. */
  publicId: string;
  displayName: string | undefined;
  /** Presence as the page's own principal sees it. */
  page: CanvasPresencePage;
  lastSeen: number;
}

interface Subscriber {
  principalId: string;
  pageId: string | undefined;
  listener: Listener;
}

interface SpacePresence {
  /** By `principalId \0 pageId`. */
  pages: Map<string, Entry>;
  /** Reports of each principal across all its pages of the Space. */
  principals: Map<string, RateWindow>;
  subscribers: Set<Subscriber>;
}

export type PresenceReportResult =
  | 'accepted'
  | 'rate-limited'
  | 'full'
  | 'principal-full';

export interface CanvasPresenceHubOptions {
  now?: () => number;
  expiryMs?: number;
  maxPagesPerSpace?: number;
  maxPagesPerPrincipal?: number;
  maxReportsPerSecond?: number;
  maxReportsPerPrincipalPerSecond?: number;
  /** Mints the id another principal sees a page under. */
  createPublicId?: () => string;
}

export interface CanvasPresenceHub {
  /**
   * Merge a page's report into its presence and relay it to the others. The
   * page is the caller's: another principal's page with the same page id is
   * a different entry and is not touched.
   */
  report(
    spaceKey: string,
    body: CanvasPresenceReportBody,
    caller?: PresenceCaller,
  ): PresenceReportResult;
  /** Drop a page of `principalId` and tell the others. */
  leave(spaceKey: string, pageId: string, principalId?: string): void;
  /**
   * Receive the presence of every page but the subscriber's own (`pageId` of
   * `principalId`). Closing the last subscription of a page drops that page.
   */
  subscribe(
    spaceKey: string,
    pageId: string | undefined,
    listener: Listener,
    principalId?: string,
  ): () => void;
  /** Pages currently present as `principalId` sees them, without its `exceptPageId`. */
  snapshot(
    spaceKey: string,
    exceptPageId?: string,
    principalId?: string,
  ): CanvasPresencePage[];
  /** Drop every page that has not reported within `expiryMs`. */
  sweep(): void;
  /** Stop the expiry timer and forget everything. */
  reset(): void;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

const entryKey = (principalId: string, pageId: string): string =>
  `${principalId}\u0000${pageId}`;

/** Start a new one-second window if the last is over; whether one more report fits. */
function hasRoom(window: RateWindow, at: number, max: number): boolean {
  if (at - window.windowStart >= 1_000) {
    window.windowStart = at;
    window.windowCount = 0;
  }
  return window.windowCount < max;
}

export function createCanvasPresenceHub(
  options: CanvasPresenceHubOptions = {},
): CanvasPresenceHub {
  const now = options.now ?? Date.now;
  const expiryMs = options.expiryMs ?? CANVAS_PRESENCE_LIMITS.expiryMs;
  const maxPages =
    options.maxPagesPerSpace ?? CANVAS_PRESENCE_LIMITS.maxPagesPerSpace;
  const maxPagesPerPrincipal =
    options.maxPagesPerPrincipal ?? CANVAS_PRESENCE_LIMITS.maxPagesPerPrincipal;
  const maxReports =
    options.maxReportsPerSecond ?? CANVAS_PRESENCE_LIMITS.maxReportsPerSecond;
  const maxPrincipalReports =
    options.maxReportsPerPrincipalPerSecond ??
    CANVAS_PRESENCE_LIMITS.maxReportsPerPrincipalPerSecond;
  const createPublicId = options.createPublicId ?? randomUUID;
  const spaces = new Map<string, SpacePresence>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const spaceFor = (spaceKey: string): SpacePresence => {
    let space = spaces.get(spaceKey);
    if (!space) {
      space = {
        pages: new Map(),
        principals: new Map(),
        subscribers: new Set(),
      };
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

  /** The id `viewerPrincipalId` knows `entry` by. */
  const idFor = (entry: Entry, viewerPrincipalId: string): string =>
    viewerPrincipalId === entry.principalId ? entry.pageId : entry.publicId;

  /** `entry` as `viewerPrincipalId` is shown it. */
  const viewOf = (
    entry: Entry,
    viewerPrincipalId: string,
  ): CanvasPresencePage => {
    const page = clonePage(entry.page);
    if (viewerPrincipalId === entry.principalId) return page;
    return {
      ...page,
      pageId: entry.publicId,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
    };
  };

  const relay = (
    space: SpacePresence,
    from: Entry,
    event: (viewerPrincipalId: string) => CanvasPresenceEventData,
  ): void => {
    for (const subscriber of space.subscribers) {
      if (
        subscriber.principalId === from.principalId &&
        subscriber.pageId === from.pageId
      )
        continue;
      try {
        subscriber.listener(event(subscriber.principalId));
      } catch {
        /* one failing stream must not stall the others */
      }
    }
  };

  const remove = (
    spaceKey: string,
    space: SpacePresence,
    key: string,
  ): void => {
    const entry = space.pages.get(key);
    if (!entry) return;
    space.pages.delete(key);
    if (
      ![...space.pages.values()].some(
        (other) => other.principalId === entry.principalId,
      )
    )
      space.principals.delete(entry.principalId);
    relay(space, entry, (viewer) => ({
      op: 'leave',
      pageId: idFor(entry, viewer),
    }));
    prune(spaceKey, space);
  };

  const sweep = (): void => {
    const deadline = now() - expiryMs;
    for (const [spaceKey, space] of spaces) {
      for (const [key, entry] of space.pages) {
        if (entry.lastSeen <= deadline) remove(spaceKey, space, key);
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
    caller: PresenceCaller,
    at: number,
    isNew: boolean,
  ): void => {
    entry.lastSeen = at;
    const page = entry.page;
    // A new page is announced whole, whatever its first report carried.
    let changed = isNew;
    if (report.label !== undefined && report.label !== page.label) {
      page.label = report.label;
      changed = true;
    }
    if (caller.displayName !== entry.displayName) {
      entry.displayName = caller.displayName;
      changed = true;
    }
    // The edit lock is for callers who may edit. One who may not (any more)
    // holds none, whatever it reports.
    const editingNodeIds =
      caller.mayHoldEditLock === false
        ? report.editingNodeIds === undefined &&
          page.editingNodeIds.length === 0
          ? undefined
          : []
        : report.editingNodeIds;
    for (const [key, ids] of [
      ['selectedNodeIds', report.selectedNodeIds],
      ['draggingNodeIds', report.draggingNodeIds],
      ['editingNodeIds', editingNodeIds],
    ] as const) {
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
      relay(space, entry, (viewer) => ({
        op: 'update',
        page: viewOf(entry, viewer),
      }));
    } else if (pointerChanged) {
      relay(space, entry, (viewer) => ({
        op: 'pointer',
        pageId: idFor(entry, viewer),
        pointer: page.pointer ? { ...page.pointer } : null,
      }));
    }
  };

  const startTimer = (): void => {
    if (timer) return;
    timer = setInterval(sweep, Math.max(250, Math.floor(expiryMs / 6)));
    timer.unref?.();
  };

  return {
    report(spaceKey, body, caller = ANONYMOUS_CALLER) {
      const space = spaceFor(spaceKey);
      const at = now();
      const key = entryKey(caller.principalId, body.pageId);
      const existing = space.pages.get(key);
      if (!existing) {
        // A place is refused before anything is recorded for the caller.
        const own = [...space.pages.values()].filter(
          (entry) => entry.principalId === caller.principalId,
        ).length;
        if (own >= maxPagesPerPrincipal || space.pages.size >= maxPages) {
          prune(spaceKey, space);
          return own >= maxPagesPerPrincipal ? 'principal-full' : 'full';
        }
      }
      // The page's own budget, then the caller's across its pages — so many
      // pages of one principal do not multiply what it may send, and nobody
      // else's budget is involved.
      if (existing && !hasRoom(existing, at, maxReports)) return 'rate-limited';
      const principal = space.principals.get(caller.principalId) ?? {
        windowStart: at,
        windowCount: 0,
      };
      if (!hasRoom(principal, at, maxPrincipalReports)) return 'rate-limited';
      principal.windowCount += 1;
      space.principals.set(caller.principalId, principal);
      if (existing) {
        existing.windowCount += 1;
        apply(space, existing, body, caller, at, false);
        return 'accepted';
      }
      const entry: Entry = {
        principalId: caller.principalId,
        pageId: body.pageId,
        publicId: createPublicId(),
        displayName: caller.displayName,
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
        windowCount: 1,
      };
      space.pages.set(key, entry);
      apply(space, entry, body, caller, at, true);
      startTimer();
      return 'accepted';
    },

    leave(spaceKey, pageId, principalId = ANONYMOUS_PRINCIPAL) {
      const space = spaces.get(spaceKey);
      if (space) remove(spaceKey, space, entryKey(principalId, pageId));
    },

    subscribe(spaceKey, pageId, listener, principalId = ANONYMOUS_PRINCIPAL) {
      const space = spaceFor(spaceKey);
      const subscriber: Subscriber = { principalId, pageId, listener };
      space.subscribers.add(subscriber);
      return () => {
        if (!space.subscribers.delete(subscriber)) return;
        const stillConnected =
          pageId !== undefined &&
          [...space.subscribers].some(
            (other) =>
              other.pageId === pageId && other.principalId === principalId,
          );
        if (pageId !== undefined && !stillConnected)
          remove(spaceKey, space, entryKey(principalId, pageId));
        prune(spaceKey, space);
      };
    },

    snapshot(spaceKey, exceptPageId, principalId = ANONYMOUS_PRINCIPAL) {
      const space = spaces.get(spaceKey);
      if (!space) return [];
      return [...space.pages.values()]
        .filter(
          (entry) =>
            !(
              entry.principalId === principalId && entry.pageId === exceptPageId
            ),
        )
        .map((entry) => viewOf(entry, principalId));
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
