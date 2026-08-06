// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Gated commit queue for derived node heights.
 *
 * A measurement is a *proposal*. Between the proposal and the store sit
 * two gates, and they solve different problems:
 *
 *  1. **Threshold** — a proposal that resolves to the height the node
 *     already has is dropped. This is what makes ResizeObserver jitter
 *     free rather than merely cheap. The comparison is exact, because it
 *     happens *after* the engine's quantization: two measurements within
 *     one quantization step resolve to the same layout height, so a
 *     separate tolerance would be dead code — no smaller difference can
 *     survive to be compared.
 *
 *  2. **Suspension** — while the user is panning, zooming, dragging, or
 *     resizing, proposals accumulate instead of dispatching, and flush
 *     once on settle. This is what makes measurement *latency* invisible:
 *     a correction that arrives mid-gesture would otherwise move geometry
 *     under the user's hand.
 *
 * Proposals are keyed by node, so a burst collapses to one entry per node
 * and the flush produces a single command — and therefore a single
 * end-of-batch frame refit — rather than one per measurement.
 *
 * Everything is validated at flush time against the live store, never at
 * enqueue time: a proposal made before a gesture may be stale by the time
 * the gesture ends (the user pinned the node, changed its width, or
 * deleted it).
 */

import {
  intrinsicToLayoutHeight,
  resolveHeightMode,
} from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';

import {
  isHeightCommitSuspended,
  onHeightCommitsSettled,
} from './commitSuspension';

import type {
  AutoHeightHint,
  CanvasNodeId,
  CanvasNodeMeasuredHeightUpdate,
} from '@huabu/shared';

export interface HeightProposal {
  nodeId: string;
  /** Content height at the node type's reference width, before chrome. */
  intrinsicHeight: number;
  /** The `AutoHeightKey` this measurement was taken under. */
  measuredFor: string;
  provisional?: boolean;
}

const pending = new Map<string, HeightProposal>();
let flushHandle: number | null = null;

onHeightCommitsSettled(() => scheduleFlush());

/**
 * Offer a measured intrinsic height for a node. Cheap to call on every
 * `ResizeObserver` tick — the gates are applied at flush time.
 */
export function proposeMeasuredHeight(proposal: HeightProposal): void {
  if (!Number.isFinite(proposal.intrinsicHeight)) return;
  if (proposal.intrinsicHeight <= 0) return;
  pending.set(proposal.nodeId, proposal);
  scheduleFlush();
}

/** Drop any pending proposal for a node (unmount, delete, type change). */
export function cancelMeasuredHeight(nodeId: string): void {
  pending.delete(nodeId);
}

function scheduleFlush(): void {
  if (isHeightCommitSuspended()) return;
  if (pending.size === 0 || flushHandle !== null) return;
  // One frame of coalescing: several notes reflowing in the same commit
  // produce one command and therefore one frame refit.
  flushHandle = requestAnimationFrame(() => {
    flushHandle = null;
    flushHeightCommits();
  });
}

function flushHeightCommits(): void {
  if (isHeightCommitSuspended() || pending.size === 0) return;

  const store = useCanvasStore.getState();
  const nodes = store.nodes;
  const items: CanvasNodeMeasuredHeightUpdate[] = [];

  for (const proposal of pending.values()) {
    const node = nodes.find((n) => n.id === proposal.nodeId);
    if (!node) continue;
    // The user pinned the node while the measurement was in flight. The
    // proposal describes a state that no longer exists.
    if (resolveHeightMode(node) !== 'auto') continue;

    const style = node.style as
      | { width?: unknown; height?: unknown }
      | undefined;
    const width = typeof style?.width === 'number' ? style.width : undefined;
    const next = intrinsicToLayoutHeight(
      proposal.intrinsicHeight,
      node.type,
      width,
    );
    const current =
      typeof style?.height === 'number' ? style.height : undefined;

    const geometrySettled = current !== undefined && next === current;
    // Geometry being settled is not enough to skip: if the content changed
    // without changing the height, the stored hint still points at the old
    // content and would be re-measured on every load forever. Commit so
    // provenance catches up even when no pixel moves.
    const hint = (node.data as { autoHeight?: AutoHeightHint } | undefined)
      ?.autoHeight;
    const provenanceSettled =
      hint?.measuredFor === proposal.measuredFor &&
      Boolean(hint?.provisional) === Boolean(proposal.provisional);
    if (geometrySettled && provenanceSettled) continue;

    items.push({
      nodeId: proposal.nodeId as CanvasNodeId,
      intrinsicHeight: proposal.intrinsicHeight,
      measuredFor: proposal.measuredFor,
      ...(proposal.provisional ? { provisional: true } : {}),
    });
  }

  pending.clear();
  if (items.length > 0) store.applyMeasuredHeights(items);
}

/** Test seam: clear all queue state between cases. */
export function __resetHeightCommitQueue(): void {
  pending.clear();
  if (flushHandle !== null) {
    cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
}

/** Test seam: run the flush synchronously. */
export function __flushHeightCommitsNow(): void {
  if (flushHandle !== null) {
    cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
  flushHeightCommits();
}
