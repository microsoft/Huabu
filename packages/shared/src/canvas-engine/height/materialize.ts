// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Materialization — turning a stored auto-height hint into concrete
 * geometry.
 *
 * This is the point where the ownership inversion becomes real. An auto
 * node's `style.height` is always a number, but on disk that number
 * carries no authority: it is re-derived from {@link AutoHeightHint} every
 * time the canvas is loaded, by whichever runtime loaded it. A client
 * that never renders the node still gets a usable footprint, and the
 * headless engine — which has no DOM to measure with — gets one too.
 *
 * Materialization never *measures*; it only applies what a measurement
 * previously produced. Producing the number requires a browser and lives
 * in the web layer.
 */

import { intrinsicToLayoutHeight } from './compute.js';
import { readAutoHeightHint } from './freshness.js';
import { getHeightPolicy, resolveHeightMode } from './policy.js';
import { getNodeDefaultSize } from '../utils/nodeSizes.js';

import type { Node } from '@xyflow/react';

/**
 * Layout height an auto node should currently occupy.
 *
 * Falls back to the node type's minimum (then its nominal default) when
 * no hint is stored, so the answer is always a positive number — the
 * invariant that stops layout solvers, snapping, and frame fitting from
 * seeing a zero-height node.
 */
export function resolveAutoLayoutHeight(node: Node): number {
  const policy = getHeightPolicy(node.type);
  const { hint } = readAutoHeightHint(node);

  const intrinsic =
    hint?.intrinsicHeight ??
    policy.minIntrinsicHeight ??
    getNodeDefaultSize(node.type ?? '').height ??
    0;

  const width = (node.style as { width?: unknown } | undefined)?.width;
  return intrinsicToLayoutHeight(
    intrinsic,
    node.type,
    typeof width === 'number' ? width : undefined,
  );
}

/**
 * Ensure a node's geometry reflects its height ownership.
 *
 * Returns the **same reference** when nothing needs to change, so callers
 * can materialize a whole canvas and still let reference-based dirty
 * detection see an unchanged array.
 *
 * `measured.height` is written alongside `style.height` because
 * `getNodeSize` resolves `measured` first; leaving it behind would let a
 * stale render-time value outrank freshly materialized geometry.
 */
export function materializeAutoHeight<T extends Node>(node: T): T {
  if (resolveHeightMode(node) !== 'auto') return node;

  const height = resolveAutoLayoutHeight(node);
  const style = (node.style ?? {}) as Record<string, unknown>;
  const measured = node.measured as
    | { width?: number; height?: number }
    | undefined;

  if (style.height === height && measured?.height === height) return node;

  return {
    ...node,
    style: { ...style, height },
    measured: { ...(measured ?? {}), height },
  };
}

/**
 * Materialize every node in a canvas. Returns the same array reference
 * when no node changed.
 */
export function materializeAutoHeights<T extends Node>(
  nodes: readonly T[],
): readonly T[] {
  let changed = false;
  const next = nodes.map((node) => {
    const materialized = materializeAutoHeight(node);
    if (materialized !== node) changed = true;
    return materialized;
  });
  return changed ? next : nodes;
}
