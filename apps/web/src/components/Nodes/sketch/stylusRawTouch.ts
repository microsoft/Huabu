// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';

import {
  detectTouchCapability,
  observeInputPointer,
} from '@/hooks/useInputMode';

import type { CSSProperties } from 'react';

/**
 * Raw-touch stylus engine for the Sketch overlay.
 *
 * WebKit synthesises Apple-Pencil pointer events through a gesture recogniser
 * that drops light / fast contacts before dispatch, so a stroke can fire no
 * `pointerdown` at all (dropped ink, and the contact falling through to the
 * native text-selection callout). The workaround is to listen to the raw,
 * non-passive `touch` stream instead, `preventDefault()` the stylus contact to
 * claim it, and replay it through the overlay's existing pointer handlers as a
 * synthetic pen event — so every commit / merge / erase / storage path is
 * reused verbatim.
 *
 * The engine is deliberately narrow: it only ever runs where a raw `Touch` can
 * be *classified* as a stylus, which is what
 * {@link isStylusRawTouchSupported} gates on. Everywhere else the browser's own
 * pointer stream is authoritative and this module is inert.
 */

/**
 * The subset of `React.PointerEvent` the Sketch overlay's pointer handlers
 * actually consume.
 *
 * Declaring it explicitly is what lets the raw-touch engine replay a stylus
 * contact without lying about its type: a synthetic contact is a complete,
 * unasserted `SketchPointer`, while a real `React.PointerEvent` is structurally
 * assignable to it, so both sources flow through the same handlers. Widening a
 * handler to read a field outside this list is a compile error rather than an
 * iPad-only crash.
 */
export interface SketchPointer {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure: number;
  readonly button: number;
  readonly buttons: number;
  readonly isPrimary: boolean;
  preventDefault(): void;
  readonly currentTarget: {
    setPointerCapture(pointerId: number): void;
    releasePointerCapture(pointerId: number): void;
    hasPointerCapture(pointerId: number): boolean;
  };
}

/**
 * Whether this browser exposes WebKit's non-standard `Touch.touchType`, the
 * only signal that separates a stylus contact from a finger contact in the raw
 * touch stream.
 *
 * This is the load-bearing half of the gate. Without it every finger touch
 * would be indistinguishable from a Pencil contact and would be replayed as a
 * pen — hijacking finger drawing on Chromium touch devices (Android tablets,
 * Windows touch laptops) and double-handling every contact.
 *
 * Probed on `Touch.prototype` rather than a live `Touch`, so it can be
 * evaluated with no event in hand. It is feature detection, not UA sniffing.
 */
function detectStylusTouchTypeSupport(): boolean {
  if (typeof window === 'undefined') return false;
  // Read through an index signature: the DOM lib types `window.Touch` as the
  // standard constructor, whose prototype has no `touchType` to probe.
  const touchCtor = (window as unknown as Record<string, unknown>).Touch;
  if (typeof touchCtor !== 'function') return false;
  const proto = (touchCtor as { prototype?: object }).prototype;
  return proto != null && 'touchType' in proto;
}

let supportedCache: boolean | undefined;

/**
 * Whether the raw-touch stylus engine is active on this device.
 *
 * Both halves are *static device capabilities*, never the live pointer mode:
 * the dropped Pencil contact this engine exists to recover never fires a
 * pointer event, so a signal derived from pointer events could not decide
 * whether to attach the engine — the first stroke would be lost before it could
 * turn itself on.
 *
 * Resolved on first call and memoised rather than at module load, so the result
 * does not depend on import order relative to the environment it probes (which
 * is also what makes it substitutable under test).
 */
export function isStylusRawTouchSupported(): boolean {
  supportedCache ??= detectTouchCapability() && detectStylusTouchTypeSupport();
  return supportedCache;
}

/**
 * Clear the memoised capability result so a test can re-probe a reconfigured
 * environment. Not used by application code.
 */
export function resetStylusRawTouchSupportForTests(): void {
  supportedCache = undefined;
}

/**
 * Namespace offset applied to synthetic pointer ids. A raw `Touch.identifier`
 * is a small integer allocated independently of the browser's `pointerId`
 * sequence, so a stylus contact and a concurrent finger pointer can collide.
 * Gesture bookkeeping (`canvasGestureSession`) is keyed by pointer id, so the
 * two namespaces must not overlap.
 */
const SYNTHETIC_POINTER_ID_OFFSET = 1_000_000;

/** Fallback pressure when the platform reports none for a stylus contact. */
const DEFAULT_STYLUS_PRESSURE = 0.5;

/**
 * `currentTarget` of a synthetic pointer. A touch is already implicitly
 * captured to its target, so pointer-capture calls are no-ops (and would
 * otherwise throw on a non-pointer id).
 *
 * It doubles as an identity marker — see {@link isStylusRawTouchPointer}. The
 * marker is this module-private object reference rather than a flag on the
 * event, so nothing outside can forge or accidentally reproduce it.
 */
const POINTER_CAPTURE_STUB: SketchPointer['currentTarget'] = {
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  hasPointerCapture: () => false,
};

/** Whether a raw `Touch` was made by a stylus rather than a finger. */
function isStylusTouch(touch: Touch): boolean {
  return (touch as Touch & { touchType?: string }).touchType === 'stylus';
}

/**
 * Build the synthetic pointer for a stylus contact. Every member of
 * {@link SketchPointer} is populated, so no type assertion is involved and the
 * overlay cannot read a field that is secretly missing.
 *
 * `buttons` reflects whether the stylus is still in contact: a replayed
 * `touchend` / `touchcancel` reports 0 the same way a real `pointerup` does.
 */
function toStylusPointerEvent(touch: Touch, inContact: boolean): SketchPointer {
  const force = (touch as Touch & { force?: number }).force;
  const pressure =
    typeof force === 'number' && force > 0 ? force : DEFAULT_STYLUS_PRESSURE;
  return {
    pointerId: SYNTHETIC_POINTER_ID_OFFSET + touch.identifier,
    pointerType: 'pen',
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure,
    button: 0,
    buttons: inContact ? 1 : 0,
    isPrimary: true,
    // The underlying `touchstart` is already `preventDefault()`ed to claim the
    // contact; the replayed pointer has no further default to suppress.
    preventDefault: () => {},
    currentTarget: POINTER_CAPTURE_STUB,
  };
}

/** Whether this pointer event was replayed by the raw-touch engine. */
function isStylusRawTouchPointer(e: SketchPointer): boolean {
  return e.currentTarget === POINTER_CAPTURE_STUB;
}

/**
 * Whether a pointer event must be dropped because the raw-touch engine already
 * owns this contact. Only browser-generated *pen* events are superseded, and
 * only where the engine is actually attached — so Chromium stylus devices
 * (Surface, Wacom) keep using their reliable pointer stream untouched.
 */
export function isSupersededByStylusRawTouch(e: SketchPointer): boolean {
  return (
    e.pointerType === 'pen' &&
    !isStylusRawTouchPointer(e) &&
    isStylusRawTouchSupported()
  );
}

const STYLUS_RAW_TOUCH_OVERLAY_STYLE: CSSProperties = {
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

/**
 * Overlay styles that stop the browser reinterpreting a claimed stylus contact
 * as scroll / text selection / long-press callout. Applied only where the
 * engine runs, so devices on the normal pointer path keep their default
 * gesture behaviour. Returns a stable object so it can be spread during render.
 */
export function getStylusRawTouchOverlayStyle(): CSSProperties | undefined {
  return isStylusRawTouchSupported()
    ? STYLUS_RAW_TOUCH_OVERLAY_STYLE
    : undefined;
}

export interface StylusRawTouchHandlers {
  onDown: (e: SketchPointer) => void;
  onMove: (e: SketchPointer) => void;
  onUp: (e: SketchPointer) => void;
  onCancel: (e: SketchPointer) => void;
}

/**
 * Attach the raw-touch stylus engine to `el`, replaying stylus contacts into
 * the handler set returned by `getHandlers`. Returns a teardown function.
 * Inert unless {@link isStylusRawTouchSupported}.
 *
 * React-independent so the replay protocol can be exercised with a plain
 * element and plain touch events; {@link useStylusRawTouch} is the thin
 * lifecycle wrapper. Handlers are pulled through `getHandlers` at dispatch time
 * so the listeners survive a draw/erase mode switch without re-attaching.
 */
export function attachStylusRawTouch(
  el: HTMLElement,
  getHandlers: () => StylusRawTouchHandlers,
): () => void {
  if (!isStylusRawTouchSupported()) return () => {};

  const forEachStylusTouch = (
    e: TouchEvent,
    inContact: boolean,
    dispatch: (pointer: SketchPointer) => void,
  ) => {
    for (const touch of Array.from(e.changedTouches)) {
      if (!isStylusTouch(touch)) continue;
      // `preventDefault()` on the contact phases is what claims the stylus
      // away from WebKit's gesture recogniser. It is idempotent, so calling it
      // per matching touch is safe.
      if (inContact) e.preventDefault();
      dispatch(toStylusPointerEvent(touch, inContact));
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    forEachStylusTouch(e, true, (pointer) => {
      // The engine is the pointer source for this contact, so it also owns
      // feeding the input-mode signal the browser would normally supply.
      // Routing in `acceptsPointer` reads it back live.
      observeInputPointer('pen');
      getHandlers().onDown(pointer);
    });
  };
  const onTouchMove = (e: TouchEvent) =>
    forEachStylusTouch(e, true, (p) => getHandlers().onMove(p));
  const onTouchEnd = (e: TouchEvent) =>
    forEachStylusTouch(e, false, (p) => getHandlers().onUp(p));
  const onTouchCancel = (e: TouchEvent) =>
    forEachStylusTouch(e, false, (p) => getHandlers().onCancel(p));

  // `passive: false` is required so `preventDefault()` above actually takes
  // effect.
  const opts = { passive: false } as const;
  el.addEventListener('touchstart', onTouchStart, opts);
  el.addEventListener('touchmove', onTouchMove, opts);
  el.addEventListener('touchend', onTouchEnd, opts);
  el.addEventListener('touchcancel', onTouchCancel, opts);
  return () => {
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchCancel);
  };
}

/**
 * React lifecycle wrapper around {@link attachStylusRawTouch}.
 *
 * Takes the element itself rather than a ref: the effect must re-run whenever
 * the overlay mounts a different node (e.g. a draw/erase branch that stops
 * sharing one DOM element), and a ref's `.current` cannot express that as a
 * dependency — the listeners would silently stay on the detached node.
 */
export function useStylusRawTouch(
  el: HTMLElement | null,
  handlers: StylusRawTouchHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!el) return;
    return attachStylusRawTouch(el, () => handlersRef.current);
  }, [el]);
}
