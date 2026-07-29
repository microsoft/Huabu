import { useEffect, useRef } from 'react';

import {
  detectTouchCapability,
  observeInputPointer,
} from '@/hooks/useInputMode';

import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

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
 * be *classified* as a stylus, which is what {@link STYLUS_RAW_TOUCH_SUPPORTED}
 * gates on. Everywhere else the browser's own pointer stream is authoritative
 * and this module is inert.
 */

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
 * evaluated once at module load with no event in hand. It is feature
 * detection, not UA sniffing.
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

/**
 * Whether the raw-touch stylus engine is active on this device.
 *
 * Both halves are *static device capabilities*, evaluated once, never the live
 * pointer mode: the dropped Pencil contact this engine exists to recover never
 * fires a pointer event, so a signal derived from pointer events could not
 * decide whether to attach the engine — the first stroke would be lost before
 * it could turn itself on.
 */
export const STYLUS_RAW_TOUCH_SUPPORTED =
  detectTouchCapability() && detectStylusTouchTypeSupport();

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
 * Capture-method stub used as the `currentTarget` of a synthetic pointer: a
 * touch is already implicitly captured to its target, so pointer-capture calls
 * are no-ops (and would otherwise throw on a non-pointer id).
 *
 * It doubles as an identity marker — see {@link isStylusRawTouchPointer}.
 */
const POINTER_CAPTURE_STUB: unknown = {
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  hasPointerCapture: () => false,
};

/** Whether a raw `Touch` was made by a stylus rather than a finger. */
function isStylusTouch(touch: Touch): boolean {
  return (touch as Touch & { touchType?: string }).touchType === 'stylus';
}

/**
 * Build the minimal synthetic `React.PointerEvent` the overlay's handlers
 * actually read. Only those fields are populated; the cast is contained here.
 */
function toStylusPointerEvent(touch: Touch): ReactPointerEvent {
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
    buttons: 1,
    isPrimary: true,
    currentTarget: POINTER_CAPTURE_STUB,
  } as unknown as ReactPointerEvent;
}

/** Whether this pointer event was replayed by the raw-touch engine. */
export function isStylusRawTouchPointer(e: ReactPointerEvent): boolean {
  return (e.currentTarget as unknown) === POINTER_CAPTURE_STUB;
}

/**
 * Whether a pointer event must be dropped because the raw-touch engine already
 * owns this contact. Only browser-generated *pen* events are superseded, and
 * only where the engine is actually attached — so Chromium stylus devices
 * (Surface, Wacom) keep using their reliable pointer stream untouched.
 */
export function isSupersededByStylusRawTouch(e: ReactPointerEvent): boolean {
  return (
    STYLUS_RAW_TOUCH_SUPPORTED &&
    e.pointerType === 'pen' &&
    !isStylusRawTouchPointer(e)
  );
}

/**
 * Overlay styles that stop the browser reinterpreting a claimed stylus contact
 * as scroll / text selection / long-press callout. Applied only where the
 * engine runs, so devices on the normal pointer path keep their default
 * gesture behaviour.
 */
export const STYLUS_RAW_TOUCH_OVERLAY_STYLE: CSSProperties | undefined =
  STYLUS_RAW_TOUCH_SUPPORTED
    ? {
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }
    : undefined;

export interface StylusRawTouchHandlers {
  onDown: (e: ReactPointerEvent) => void;
  onMove: (e: ReactPointerEvent) => void;
  onUp: (e: ReactPointerEvent) => void;
  onCancel: (e: ReactPointerEvent) => void;
}

/**
 * Attach the raw-touch stylus engine to `targetRef`, replaying stylus contacts
 * into `handlers`. Inert unless {@link STYLUS_RAW_TOUCH_SUPPORTED}.
 *
 * Handlers are read through a ref so the non-passive listeners stay attached
 * across renders and across a draw/erase mode switch — the caller may pass a
 * different handler set every render.
 */
export function useStylusRawTouch(
  targetRef: RefObject<HTMLElement | null>,
  handlers: StylusRawTouchHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!STYLUS_RAW_TOUCH_SUPPORTED) return;
    const el = targetRef.current;
    if (!el) return;

    const forEachStylusTouch = (
      e: TouchEvent,
      claim: boolean,
      dispatch: (e: ReactPointerEvent) => void,
    ) => {
      for (const touch of Array.from(e.changedTouches)) {
        if (!isStylusTouch(touch)) continue;
        if (claim) e.preventDefault();
        dispatch(toStylusPointerEvent(touch));
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      forEachStylusTouch(e, true, (pointer) => {
        // The engine is the pointer source for this contact, so it also owns
        // feeding the input-mode signal the browser would normally supply.
        // Routing in `acceptsPointer` reads it back live.
        observeInputPointer('pen');
        handlersRef.current.onDown(pointer);
      });
    };
    const onTouchMove = (e: TouchEvent) =>
      forEachStylusTouch(e, true, (p) => handlersRef.current.onMove(p));
    const onTouchEnd = (e: TouchEvent) =>
      forEachStylusTouch(e, false, (p) => handlersRef.current.onUp(p));
    const onTouchCancel = (e: TouchEvent) =>
      forEachStylusTouch(e, false, (p) => handlersRef.current.onCancel(p));

    // `passive: false` is required: `preventDefault()` is what claims the
    // contact away from WebKit's gesture recogniser.
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
  }, [targetRef]);
}
