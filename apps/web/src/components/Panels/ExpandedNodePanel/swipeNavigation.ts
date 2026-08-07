// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import type { ExpandedNodeDirection } from './navigation';

/** Travel needed before a drag counts as a navigation swipe. */
const SWIPE_MIN_DISTANCE_PX = 56;
/** Travel after which the gesture commits to one axis. */
const SWIPE_AXIS_LOCK_PX = 12;
/** Vertical drift allowed, as a fraction of the horizontal travel. */
const SWIPE_MAX_OFF_AXIS_RATIO = 0.6;
/** Slower drags are treated as scrolling/reading, not as a swipe. */
const SWIPE_MAX_DURATION_MS = 700;

/**
 * Elements that own a horizontal drag themselves. Deliberately narrower than
 * the arrow-key blocklist: `contenteditable` stays swipeable, because notes are
 * the surface people navigate between most and the note editor takes focus the
 * moment it expands.
 */
const SWIPE_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[role="slider"]',
  '[role="menu"]',
  '[role="menuitem"]',
  'button',
  'a[href]',
  'video',
  'audio',
  'iframe',
  '[data-expanded-node-arrow-owner]',
].join(',');

/**
 * Maps a finished touch drag onto the same navigation the arrow-key shortcuts
 * perform. Swiping the content leftwards pulls the *next* node into view, so it
 * mirrors ArrowRight (downstream) — the carousel convention, not the direction
 * the finger points at.
 */
export function resolveSwipeDirection(
  dx: number,
  dy: number,
  durationMs: number,
): ExpandedNodeDirection | null {
  if (durationMs > SWIPE_MAX_DURATION_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return null;
  if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_OFF_AXIS_RATIO) return null;
  return dx < 0 ? 'outgoing' : 'incoming';
}

/** `null` until the drag has travelled far enough to commit to an axis. */
export function resolveSwipeAxis(
  dx: number,
  dy: number,
): 'horizontal' | 'vertical' | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_AXIS_LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}

/**
 * True when the drag started inside something that scrolls horizontally (wide
 * tables, code blocks, image strips) and therefore owns the gesture itself.
 */
export function hasHorizontalScrollAncestor(
  target: EventTarget | null,
  boundary: Element,
): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.scrollWidth - el.clientWidth > 1) {
      const { overflowX } = window.getComputedStyle(el);
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    if (el === boundary) return false;
    el = el.parentElement;
  }
  return false;
}

/** Dragging a selection handle must not be mistaken for a swipe. */
function hasActiveSelection(scopeEl: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const anchor = selection.anchorNode;
  return !!anchor && scopeEl.contains(anchor);
}

type SwipeStart = {
  identifier: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  time: number;
  axis: 'horizontal' | 'vertical' | null;
};

function findTouch(list: TouchList, identifier: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].identifier === identifier) return list[i];
  }
  return null;
}

/**
 * Touch-screen counterpart of the upstream/downstream arrow shortcuts: a
 * horizontal one-finger swipe over `scopeEl` navigates to a connected node.
 *
 * Raw touch events rather than pointer events, because the browser owns a touch
 * until someone calls `preventDefault`: left alone it direction-locks the drag
 * into a scroll, fires `pointercancel` and stops reporting movement, so a
 * pointer-based swipe never accumulates enough travel to register. Here the
 * first few pixels decide the axis — a horizontal verdict claims the gesture,
 * a vertical one hands it straight back for native scrolling.
 */
export function useSwipeNavigation(
  scopeEl: HTMLElement | null,
  onSwipe: ((direction: ExpandedNodeDirection) => void) | undefined,
): void {
  const onSwipeRef = useRef(onSwipe);
  const enabled = !!onSwipe;

  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  // Deliberately keyed on `enabled` rather than the callback itself: the
  // neighbour lists it closes over change identity on every store update, and
  // re-attaching mid-drag would forget the gesture in progress.
  useEffect(() => {
    if (!scopeEl || !enabled) return;

    let start: SwipeStart | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = e.changedTouches[0];
      if (!touch) return;
      if (
        e.target instanceof Element &&
        e.target.closest(SWIPE_OWNER_SELECTOR)
      ) {
        return;
      }
      if (hasHorizontalScrollAncestor(e.target, scopeEl)) return;
      if (hasActiveSelection(scopeEl)) return;
      start = {
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        time: e.timeStamp,
        axis: null,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      // A second finger means pinch/pan, so drop the in-flight gesture.
      if (e.touches.length > 1) {
        start = null;
        return;
      }
      const touch = findTouch(e.touches, start.identifier);
      if (!touch) return;
      start.lastX = touch.clientX;
      start.lastY = touch.clientY;

      if (!start.axis) {
        const axis = resolveSwipeAxis(
          start.lastX - start.x,
          start.lastY - start.y,
        );
        if (axis === 'vertical') {
          start = null;
          return;
        }
        start.axis = axis;
      }
      // Keeps the browser from turning the rest of the drag into a scroll.
      if (start.axis === 'horizontal' && e.cancelable) e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      const gesture = start;
      start = null;
      if (!gesture || gesture.axis !== 'horizontal') return;
      if (!findTouch(e.changedTouches, gesture.identifier)) return;
      const direction = resolveSwipeDirection(
        gesture.lastX - gesture.x,
        gesture.lastY - gesture.y,
        e.timeStamp - gesture.time,
      );
      if (direction) onSwipeRef.current?.(direction);
    };

    scopeEl.addEventListener('touchstart', onTouchStart, { passive: true });
    scopeEl.addEventListener('touchmove', onTouchMove, { passive: false });
    scopeEl.addEventListener('touchend', onTouchEnd);
    scopeEl.addEventListener('touchcancel', onTouchEnd);
    return () => {
      scopeEl.removeEventListener('touchstart', onTouchStart);
      scopeEl.removeEventListener('touchmove', onTouchMove);
      scopeEl.removeEventListener('touchend', onTouchEnd);
      scopeEl.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [scopeEl, enabled]);
}
