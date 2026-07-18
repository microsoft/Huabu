/**
 * Single entry point for "who currently owns the canvas gesture?"
 *
 * Two independent module singletons arbitrate canvas interaction:
 *
 *   • {@link canTouchTakeOverCanvasGesture} — the pan / lasso / sketch
 *     gesture arbiter (`canvasGestureSession`).
 *   • {@link isSnapSessionActive} — the node drag / resize snap session
 *     (`snapSession`).
 *
 * Touch takeover decisions need to reason about both. Rather than let
 * every consumer reach into both singletons (and risk each one checking
 * a different subset), the takeover questions are composed here so the
 * relationship between the two owners lives in one place.
 */

import { canTouchTakeOverCanvasGesture } from './canvasGestureSession';
import { isSnapSessionActive } from './snap/snapSession';

/**
 * Whether a new single-finger touch may claim a viewport gesture.
 *
 * Only the pan / lasso / sketch arbiter gates this: an active node-drag
 * snap session cannot coexist with a *first* touch, because the finger
 * already driving the drag makes the live pointer count ≥ 2.
 */
export function canTouchClaimViewport(): boolean {
  return canTouchTakeOverCanvasGesture();
}

/**
 * Whether a second finger may take over as a pinch / two-finger
 * navigation gesture. Rejected while a node-drag snap session owns the
 * canvas so an in-flight drag is never hijacked mid-gesture.
 */
export function canTouchTakeOverForPinch(): boolean {
  return !isSnapSessionActive() && canTouchTakeOverCanvasGesture();
}
