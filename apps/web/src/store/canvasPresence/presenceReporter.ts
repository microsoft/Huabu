// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import type { PresenceReportOutcome } from '@/api/canvasPresence';
import type {
  CanvasPresencePoint,
  CanvasPresenceReportBody,
} from '@huabu/shared';

export interface PresenceNodeState {
  selectedNodeIds: readonly string[];
  draggingNodeIds: readonly string[];
  editingNodeIds: readonly string[];
}

export interface PresenceReporterOptions {
  pageId: string;
  label: string;
  send: (body: CanvasPresenceReportBody) => Promise<PresenceReportOutcome>;
  leave: () => void;
  /** Minimum gap between two reports. */
  intervalMs?: number;
  /** How often the whole state is repeated so the page stays present. */
  heartbeatMs?: number;
}

export interface PresenceReporter {
  /** Flow position of the pointer, or `null` once it is off the canvas. */
  setPointer(pointer: CanvasPresencePoint | null): void;
  setNodes(nodes: Partial<PresenceNodeState>): void;
  /** Send the whole state: on (re)connect and as the heartbeat. */
  announce(): void;
  /** Stop reporting and withdraw this page's presence. */
  stop(): void;
}

const NODE_KEYS = [
  'selectedNodeIds',
  'draggingNodeIds',
  'editingNodeIds',
] as const;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Reports this page's presence, at most one request at a time and at most one
 * per `intervalMs`. Whatever changed while waiting is sent as one report
 * carrying only the latest values, so pointer movement costs a bounded
 * number of small requests however fast the pointer moves.
 */
export function createPresenceReporter(
  options: PresenceReporterOptions,
): PresenceReporter {
  const intervalMs =
    options.intervalMs ?? CANVAS_PRESENCE_LIMITS.reportIntervalMs;
  const heartbeatMs = options.heartbeatMs ?? CANVAS_PRESENCE_LIMITS.heartbeatMs;
  const max = CANVAS_PRESENCE_LIMITS.maxNodeIds;

  let pointer: CanvasPresencePoint | null = null;
  const nodes: Record<(typeof NODE_KEYS)[number], string[]> = {
    selectedNodeIds: [],
    draggingNodeIds: [],
    editingNodeIds: [],
  };
  const dirty = { pointer: false, nodes: false, all: false };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let notBefore = 0;
  let stopped = false;

  const schedule = (): void => {
    if (stopped || inFlight || timer !== null) return;
    if (!dirty.pointer && !dirty.nodes && !dirty.all) return;
    timer = setTimeout(flush, Math.max(0, notBefore - Date.now()));
  };

  const flush = (): void => {
    timer = null;
    if (stopped) return;
    const body: CanvasPresenceReportBody = { pageId: options.pageId };
    if (dirty.all) body.label = options.label;
    if (dirty.all || dirty.pointer) body.pointer = pointer;
    if (dirty.all || dirty.nodes) {
      for (const key of NODE_KEYS) body[key] = [...nodes[key]];
    }
    const sentNodes = dirty.all || dirty.nodes;
    dirty.pointer = dirty.nodes = dirty.all = false;
    inFlight = true;
    notBefore = Date.now() + intervalMs;
    void options.send(body).then((outcome) => {
      inFlight = false;
      if (!outcome.ok) {
        if (outcome.retryAfterMs !== null) {
          // Refused for now: wait, then resend whatever this report carried.
          notBefore = Math.max(notBefore, Date.now() + outcome.retryAfterMs);
          if (sentNodes) dirty.all = true;
          else dirty.pointer = true;
        }
        // Any other failure heals with the next heartbeat or change.
      }
      schedule();
    });
  };

  const heartbeat = setInterval(() => {
    dirty.all = true;
    schedule();
  }, heartbeatMs);

  return {
    setPointer(next) {
      if (stopped) return;
      if (next?.x === pointer?.x && next?.y === pointer?.y) return;
      pointer = next ? { x: next.x, y: next.y } : null;
      dirty.pointer = true;
      schedule();
    },
    setNodes(next) {
      if (stopped) return;
      for (const key of NODE_KEYS) {
        const ids = next[key]?.slice(0, max);
        if (!ids || sameIds(ids, nodes[key])) continue;
        nodes[key] = ids;
        dirty.nodes = true;
      }
      schedule();
    },
    announce() {
      if (stopped) return;
      dirty.all = true;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      options.leave();
    },
  };
}
