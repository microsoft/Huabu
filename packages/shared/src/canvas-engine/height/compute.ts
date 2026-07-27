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

import { getHeightPolicy, type HeightPolicy } from './policy.js';

/**
 * Lower bound on the width/refWidth scale factor. Mirrors the clamp in
 * the web `useNodeScale` hook: a very narrow node keeps its content
 * legible rather than shrinking without limit.
 */
export const MIN_CONTENT_SCALE = 0.5;

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
 */
export function contentScaleFor(
  policy: HeightPolicy,
  width: number | undefined,
): number {
  const refWidth = policy.refWidth;
  if (!refWidth || typeof width !== 'number' || !Number.isFinite(width)) {
    return 1;
  }
  return Math.max(MIN_CONTENT_SCALE, width / refWidth);
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
