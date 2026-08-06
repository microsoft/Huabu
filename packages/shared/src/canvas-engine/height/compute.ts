// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Intrinsic content height → node layout height.
 *
 * The one pure conversion shared by every producer and consumer of an
 * auto height. A measurement taken in a browser is an *intrinsic* height:
 * the unscaled height of the content at the node type's reference width.
 * The number written to `style.height` is a *layout* height: intrinsic,
 * clamped, scaled by the node's current width, plus chrome.
 *
 * Keeping the conversion here means the web measurer, the headless engine,
 * and any future server-side layout pass all agree without sharing a DOM.
 */

import {
  getHeightPolicy,
  NODE_SHELL_INSET,
  type HeightPolicy,
} from './policy.js';

/**
 * Absolute floor on the content scale, used when a type declares no
 * legibility floor of its own.
 *
 * Not a readability setting — that is {@link HeightPolicy.minContentScale},
 * and a type whose height derives from the scale deliberately has none.
 * This only keeps a zero or negative width (a node narrower than its own
 * border) from producing a scale of zero and a height of zero.
 */
const MIN_ABSOLUTE_SCALE = 0.01;

/**
 * Quantization step (px) applied to every committed auto height.
 *
 * Two clients measuring the same content can legitimately disagree by a
 * fraction of a pixel — different font builds, DPR, or browser text
 * shaping. Snapping the committed value to a step collapses that
 * disagreement to the same number, so it produces no write and no
 * cross-client geometry churn. It also absorbs sub-pixel jitter from a
 * single client's own `ResizeObserver`.
 *
 * The step is the tuning knob if divergence ever exceeds it in practice.
 */
export const HEIGHT_QUANTIZATION_STEP = 4;

/** Snap a height up to the next {@link HEIGHT_QUANTIZATION_STEP} multiple. */
export function quantizeHeight(height: number): number {
  if (!Number.isFinite(height)) return 0;
  return (
    Math.ceil(height / HEIGHT_QUANTIZATION_STEP) * HEIGHT_QUANTIZATION_STEP
  );
}

/**
 * Scale factor a node's content renders at, given its current width.
 * `1` for node types whose content does not scale with width.
 *
 * Divides the node's *content* width — its box minus the shell border —
 * rather than its outer width. That is what makes the logical layout
 * width land on `refWidth` exactly at every node size: the scaled
 * container is `100/scale%` of a box the border has already narrowed, so
 * dividing by the outer width would leave the content laying out a few
 * pixels short and, worse, by a *different* amount at each node width.
 * Content measured at one width would then wrap differently at another,
 * which is precisely what an intrinsic height must not depend on.
 *
 * The legibility floor is per type rather than global, because it is a
 * rendering policy that a derived height cannot tolerate: once it
 * engages the content stops shrinking and starts laying out narrower
 * than `refWidth`, so a height measured at that reference no longer
 * applies. See {@link HeightPolicy.minContentScale}.
 */
export function contentScaleFor(
  policy: HeightPolicy,
  width: number | undefined,
): number {
  const refWidth = policy.refWidth;
  if (!refWidth || typeof width !== 'number' || !Number.isFinite(width)) {
    return 1;
  }
  const scale = (width - NODE_SHELL_INSET) / refWidth;
  return Math.max(policy.minContentScale ?? MIN_ABSOLUTE_SCALE, scale);
}

/**
 * Convert an intrinsic (unscaled) content height into the layout height
 * to write to `style.height`.
 *
 * The order matters and mirrors the DOM: the minimum applies to the
 * *unscaled* content, scaling applies to the clamped result, and chrome
 * outside the measured element is added last so it is not scaled twice.
 *
 * The result is quantized, which makes this function the single place
 * where "is this correction worth committing?" can be answered by simple
 * equality against the current value.
 */
export function intrinsicToLayoutHeight(
  intrinsicHeight: number,
  nodeType: string | undefined,
  width: number | undefined,
): number {
  const policy = getHeightPolicy(nodeType);
  const clamped = Math.max(intrinsicHeight, policy.minIntrinsicHeight ?? 0);
  const scaled = clamped * contentScaleFor(policy, width);
  return quantizeHeight(scaled + (policy.insetY ?? 0));
}
