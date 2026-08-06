// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Viewport-priority prewarming of note heights.
 *
 * Bar A — rendering never causes a geometry change — is met without this.
 * What remains after it is one bounded correction per content change,
 * and the user sees that correction whenever they arrive at a node before
 * its measurement does. This queue is how the measurement gets there
 * first.
 *
 * Two things follow from that framing:
 *
 * - **Order is by distance from the viewport**, not FIFO. Reaching a node
 *   the user is about to look at matters; reaching one on the far side of
 *   the canvas does not.
 * - **Scheduling is idle**, and a cold start on a large canvas will
 *   legitimately be outrun. Bar B means "no size change in the steady
 *   state", not "never".
 *
 * Nodes whose hint is already `current` are skipped outright, so a warm
 * canvas queues almost nothing and the queue costs one walk on load.
 */

import {
  autoHeightKey,
  getHeightPolicy,
  readAutoHeightHint,
  resolveHeightMode,
} from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

import { proposeMeasuredHeight } from '../commitQueue';
import { measureNoteHeightOffscreen } from './offscreenMeasurer';

import type { Node } from '@xyflow/react';

/** Nodes measured per idle turn before yielding back to the browser. */
const BATCH_SIZE = 3;

/** Re-scan this long after the last store change settles. */
const RESCAN_DEBOUNCE_MS = 400;

export interface PrewarmCandidate {
  nodeId: string;
  markdown: string;
  /**
   * Key of the content being measured, captured *before* the async
   * measurement starts. Stamping the node's key at commit time instead
   * would fabricate freshness for content this measurement never saw.
   */
  measuredFor: string;
  /** Lower sorts first. */
  priority: number;
}

let running = false;
let stopped = true;
let rescanHandle: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Nodes measured this session, keyed by node id + measurement key.
 * Prevents a node whose commit was rejected (pinned mid-flight, geometry
 * unchanged) from being re-measured on every rescan.
 */
const attempted = new Set<string>();

/** Begin prewarming for the mounted canvas. Idempotent. */
export function startHeightPrewarm(): void {
  if (!stopped) return;
  stopped = false;
  unsubscribe = useCanvasStore.subscribe(scheduleRescan);
  scheduleRescan();
}

/** Stop prewarming and forget this canvas's attempts. */
export function stopHeightPrewarm(): void {
  stopped = true;
  unsubscribe?.();
  unsubscribe = null;
  if (rescanHandle !== null) {
    clearTimeout(rescanHandle);
    rescanHandle = null;
  }
  attempted.clear();
}

function scheduleRescan(): void {
  if (stopped || running) return;
  if (rescanHandle !== null) clearTimeout(rescanHandle);
  rescanHandle = setTimeout(() => {
    rescanHandle = null;
    void drain();
  }, RESCAN_DEBOUNCE_MS);
}

async function drain(): Promise<void> {
  if (stopped || running) return;
  running = true;
  try {
    for (;;) {
      if (stopped) return;
      const batch = collectCandidates().slice(0, BATCH_SIZE);
      if (batch.length === 0) return;

      const canvasId = useCanvasStore.getState().canvasId;
      for (const candidate of batch) {
        if (stopped) return;
        attempted.add(attemptKey(candidate.nodeId, candidate.measuredFor));
        try {
          const measured = await measureNoteHeightOffscreen({
            markdown: candidate.markdown,
            canvasId,
          });
          if (stopped || measured.height <= 0) continue;
          // The note was edited while its measurement was in flight, so
          // this height describes content the node no longer has. Drop
          // it; the next scan picks the node up again.
          if (currentKeyOf(candidate.nodeId) !== candidate.measuredFor)
            continue;
          proposeMeasuredHeight({
            nodeId: candidate.nodeId,
            intrinsicHeight: measured.height,
            measuredFor: candidate.measuredFor,
            provisional: measured.provisional,
          });
        } catch {
          // A measurement that throws is not worth retrying this
          // session; the node keeps its existing footprint and
          // self-measures if the user reaches it.
        }
      }
      await nextIdle();
    }
  } finally {
    running = false;
  }
}

/**
 * Auto-height notes whose stored hint no longer describes their content,
 * ordered by how soon the user is likely to see them.
 *
 * Pure: the queue's scheduling reads the store, but which nodes are worth
 * measuring and in what order is decided here, from arguments alone.
 */
export function selectPrewarmCandidates(
  nodes: readonly Node[],
  centre: Point,
  attempts: ReadonlySet<string> = new Set(),
): PrewarmCandidate[] {
  const candidates: PrewarmCandidate[] = [];

  for (const node of nodes) {
    if (getHeightPolicy(node.type).kind !== 'toggleable') continue;
    if (resolveHeightMode(node) !== 'auto') continue;

    const { freshness } = readAutoHeightHint(node);
    if (freshness === 'current') continue;

    const markdown = markdownOf(node);
    if (markdown === null) continue;
    const measuredFor = autoHeightKey(node);
    if (attempts.has(attemptKey(node.id, measuredFor))) continue;

    candidates.push({
      nodeId: node.id,
      markdown,
      measuredFor,
      priority: priorityOf(node, centre, freshness === 'missing'),
    });
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
}

function collectCandidates(): PrewarmCandidate[] {
  const { nodes, viewport } = useCanvasStore.getState();
  return selectPrewarmCandidates(nodes, viewportCentre(viewport), attempted);
}

/**
 * Distance from the viewport centre, with never-measured nodes pulled
 * ahead of stale ones: a missing hint means the node is sitting at its
 * policy minimum, which is the largest correction still outstanding.
 */
function priorityOf(node: Node, centre: Point, missing: boolean): number {
  const dx = node.position.x - centre.x;
  const dy = node.position.y - centre.y;
  const distance = Math.hypot(dx, dy);
  return missing ? distance : distance + MISSING_BIAS;
}

/** Distance (canvas px) a stale node is pushed behind a missing one. */
const MISSING_BIAS = 20000;

export interface Point {
  x: number;
  y: number;
}

function viewportCentre(
  viewport: { x: number; y: number; zoom: number } | null,
): Point {
  if (!viewport || viewport.zoom <= 0) return { x: 0, y: 0 };
  // Screen centre projected into canvas space.
  return {
    x: (window.innerWidth / 2 - viewport.x) / viewport.zoom,
    y: (window.innerHeight / 2 - viewport.y) / viewport.zoom,
  };
}

function markdownOf(node: Node): string | null {
  const content = (node.data as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content : null;
}

/**
 * The key the node's content would be measured under *right now*. Used
 * to detect an edit that landed while a measurement was in flight.
 */
function currentKeyOf(nodeId: string): string | null {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  return node ? autoHeightKey(node) : null;
}

function attemptKey(nodeId: string, measuredFor: string): string {
  return `${nodeId}:${measuredFor}`;
}

function nextIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (
      window as Window & {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 50);
  });
}

/** Test seam. */
export function __resetHeightPrewarm(): void {
  stopHeightPrewarm();
  running = false;
}
