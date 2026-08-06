// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the Sketch raw-touch stylus engine.
 *
 * The engine only ever runs on WebKit tablets, so the behaviour it guards
 * cannot be exercised by hand on the machines this repo is developed on. These
 * tests stand in for that device: they drive the capability gate through both
 * of its halves, pin the browser-vs-replayed arbitration truth table, and push
 * plain touch events through the DOM-level core to assert the replay protocol.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInputModeStore } from '@/hooks/useInputMode';
import { useToolStore } from '@/store/toolStore';

import {
  attachStylusRawTouch,
  getStylusRawTouchOverlayStyle,
  isStylusRawTouchSupported,
  isSupersededByStylusRawTouch,
  resetStylusRawTouchSupportForTests,
} from '../stylusRawTouch';

import type { SketchPointer, StylusRawTouchHandlers } from '../stylusRawTouch';

/** Namespace offset the engine applies to `Touch.identifier`. */
const SYNTHETIC_POINTER_ID_OFFSET = 1_000_000;

/**
 * Reconfigure the two static capabilities the gate probes, then clear its
 * memo so the next call re-reads the environment we just installed.
 */
function configureDevice(opts: {
  touchCapable: boolean;
  exposesTouchType: boolean;
}): void {
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: opts.touchCapable ? 5 : 0,
    configurable: true,
  });
  // Pin the media query to `false` so `maxTouchPoints` is the only signal.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  // `touchType` must live on the prototype: the gate probes the constructor's
  // prototype, not an instance, so a class field would not be visible.
  class StylusAwareTouch {
    get touchType(): string {
      return 'direct';
    }
  }
  class PlainTouch {}
  (window as unknown as Record<string, unknown>).Touch = opts.exposesTouchType
    ? StylusAwareTouch
    : PlainTouch;

  resetStylusRawTouchSupportForTests();
}

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
  force?: number;
  touchType: string;
}

function stylusTouch(overrides: Partial<FakeTouch> = {}): FakeTouch {
  return {
    identifier: 3,
    clientX: 10,
    clientY: 20,
    force: 0.4,
    touchType: 'stylus',
    ...overrides,
  };
}

function fingerTouch(overrides: Partial<FakeTouch> = {}): FakeTouch {
  return { ...stylusTouch(overrides), touchType: 'direct' };
}

/**
 * Build a cancelable touch event carrying `touches` as `changedTouches`.
 * happy-dom has no `TouchEvent` constructor, and the engine only reads
 * `changedTouches` plus `preventDefault`, so a plain `Event` is sufficient and
 * keeps `defaultPrevented` observable.
 */
function touchEvent(type: string, touches: FakeTouch[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  return event;
}

/** A pointer as the browser would deliver it (not replayed by the engine). */
function browserPointer(pointerType: string): SketchPointer {
  return {
    pointerId: 1,
    pointerType,
    clientX: 0,
    clientY: 0,
    pressure: 0.5,
    button: 0,
    buttons: 1,
    isPrimary: true,
    preventDefault: () => {},
    currentTarget: {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
    },
  };
}

function recordingHandlers(): {
  handlers: StylusRawTouchHandlers;
  calls: Array<{ phase: keyof StylusRawTouchHandlers; pointer: SketchPointer }>;
} {
  const calls: Array<{
    phase: keyof StylusRawTouchHandlers;
    pointer: SketchPointer;
  }> = [];
  return {
    calls,
    handlers: {
      onDown: (pointer) => calls.push({ phase: 'onDown', pointer }),
      onMove: (pointer) => calls.push({ phase: 'onMove', pointer }),
      onUp: (pointer) => calls.push({ phase: 'onUp', pointer }),
      onCancel: (pointer) => calls.push({ phase: 'onCancel', pointer }),
    },
  };
}

beforeEach(() => {
  configureDevice({ touchCapable: true, exposesTouchType: true });
  useToolStore.setState({ inputModePreference: 'auto', penObserved: false });
  useInputModeStore.setState({ mode: 'mouse' });
});

describe('capability gate', () => {
  it('is active only when the device is touch-capable AND exposes touchType', () => {
    configureDevice({ touchCapable: true, exposesTouchType: true });
    expect(isStylusRawTouchSupported()).toBe(true);

    // Without `touchType` a finger contact is indistinguishable from a stylus
    // contact, so the engine must stay off rather than hijack finger drawing.
    configureDevice({ touchCapable: true, exposesTouchType: false });
    expect(isStylusRawTouchSupported()).toBe(false);

    configureDevice({ touchCapable: false, exposesTouchType: true });
    expect(isStylusRawTouchSupported()).toBe(false);
  });

  it('memoises the probe result', () => {
    expect(isStylusRawTouchSupported()).toBe(true);
    // Degrade the environment without resetting the memo.
    Object.defineProperty(window.navigator, 'maxTouchPoints', {
      value: 0,
      configurable: true,
    });
    expect(isStylusRawTouchSupported()).toBe(true);
  });

  it('applies gesture-suppressing overlay styles only where it runs', () => {
    expect(getStylusRawTouchOverlayStyle()).toMatchObject({
      touchAction: 'none',
    });

    configureDevice({ touchCapable: true, exposesTouchType: false });
    expect(getStylusRawTouchOverlayStyle()).toBeUndefined();
  });
});

describe('isSupersededByStylusRawTouch', () => {
  it('drops the browser pen stream where the engine runs', () => {
    expect(isSupersededByStylusRawTouch(browserPointer('pen'))).toBe(true);
  });

  it('never drops mouse or touch pointers', () => {
    expect(isSupersededByStylusRawTouch(browserPointer('mouse'))).toBe(false);
    expect(isSupersededByStylusRawTouch(browserPointer('touch'))).toBe(false);
  });

  it('leaves the browser pen stream alone where the engine does not run', () => {
    // Chromium stylus hardware (Surface, Wacom) must keep its reliable stream.
    configureDevice({ touchCapable: true, exposesTouchType: false });
    expect(isSupersededByStylusRawTouch(browserPointer('pen'))).toBe(false);
  });

  it('lets the engine\u2019s own replayed contacts through', () => {
    const el = document.createElement('div');
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));

    const replayed = calls[0].pointer;
    expect(replayed.pointerType).toBe('pen');
    // The exact invariant the guard exists for: a replayed contact is a pen,
    // but must not be treated as superseded or it would be dropped by its own
    // handler and no stroke would ever start.
    expect(isSupersededByStylusRawTouch(replayed)).toBe(false);
  });
});

describe('attachStylusRawTouch', () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
  });

  it('replays a stylus contact as a synthetic pen pointer', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(
      touchEvent('touchstart', [
        stylusTouch({ identifier: 7, clientX: 42, clientY: 99, force: 0.25 }),
      ]),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].phase).toBe('onDown');
    expect(calls[0].pointer).toMatchObject({
      pointerType: 'pen',
      clientX: 42,
      clientY: 99,
      pressure: 0.25,
      button: 0,
      buttons: 1,
      isPrimary: true,
    });
  });

  it('namespaces synthetic pointer ids away from browser pointer ids', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(
      touchEvent('touchstart', [stylusTouch({ identifier: 2 })]),
    );

    // Gesture bookkeeping is keyed by pointer id, so a small `Touch.identifier`
    // must not be able to collide with a concurrent finger's pointer id.
    expect(calls[0].pointer.pointerId).toBe(SYNTHETIC_POINTER_ID_OFFSET + 2);
  });

  it('substitutes a default pressure when the platform reports none', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(touchEvent('touchstart', [stylusTouch({ force: 0 })]));

    expect(calls[0].pointer.pressure).toBeGreaterThan(0);
  });

  it('claims contact phases and leaves release phases alone', () => {
    const { handlers } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    const down = touchEvent('touchstart', [stylusTouch()]);
    el.dispatchEvent(down);
    // preventDefault() is what takes the contact away from WebKit's gesture
    // recogniser; without it the stroke falls through to the selection callout.
    expect(down.defaultPrevented).toBe(true);

    const move = touchEvent('touchmove', [stylusTouch()]);
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);

    const up = touchEvent('touchend', [stylusTouch()]);
    el.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);
  });

  it('reports buttons=0 once the stylus lifts', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(touchEvent('touchend', [stylusTouch()]));

    expect(calls[0].phase).toBe('onUp');
    expect(calls[0].pointer.buttons).toBe(0);
  });

  it('ignores finger contacts entirely', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    const down = touchEvent('touchstart', [fingerTouch()]);
    el.dispatchEvent(down);

    expect(calls).toHaveLength(0);
    // A finger must stay with the browser so pinch-zoom / pan keep working.
    expect(down.defaultPrevented).toBe(false);
  });

  it('replays only the stylus out of a mixed multi-touch contact', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(
      touchEvent('touchstart', [
        fingerTouch({ identifier: 1 }),
        stylusTouch({ identifier: 2 }),
        fingerTouch({ identifier: 4 }),
      ]),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].pointer.pointerId).toBe(SYNTHETIC_POINTER_ID_OFFSET + 2);
  });

  it('routes each touch phase to its matching handler', () => {
    const { handlers, calls } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));
    el.dispatchEvent(touchEvent('touchmove', [stylusTouch()]));
    el.dispatchEvent(touchEvent('touchend', [stylusTouch()]));
    el.dispatchEvent(touchEvent('touchcancel', [stylusTouch()]));

    expect(calls.map((c) => c.phase)).toEqual([
      'onDown',
      'onMove',
      'onUp',
      'onCancel',
    ]);
  });

  it('reports the pen observation so live input-mode routing accepts it', () => {
    const { handlers } = recordingHandlers();
    attachStylusRawTouch(el, () => handlers);

    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));

    // The engine bypasses the browser pointer stream, so it must feed the
    // input-mode signal itself; otherwise `auto` still resolves to `finger`
    // and the very first stroke is rejected by `acceptsPointer`.
    expect(useToolStore.getState().penObserved).toBe(true);
    expect(useInputModeStore.getState().mode).toBe('pen');
  });

  it('pulls handlers at dispatch time so a mode switch is picked up', () => {
    const draw = recordingHandlers();
    const erase = recordingHandlers();
    let current = draw.handlers;
    attachStylusRawTouch(el, () => current);

    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));
    current = erase.handlers;
    el.dispatchEvent(touchEvent('touchmove', [stylusTouch()]));

    expect(draw.calls.map((c) => c.phase)).toEqual(['onDown']);
    expect(erase.calls.map((c) => c.phase)).toEqual(['onMove']);
  });

  it('stops replaying after teardown', () => {
    const { handlers, calls } = recordingHandlers();
    const detach = attachStylusRawTouch(el, () => handlers);

    detach();
    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));

    expect(calls).toHaveLength(0);
  });

  it('is inert on devices outside the gate', () => {
    configureDevice({ touchCapable: true, exposesTouchType: false });
    const { handlers, calls } = recordingHandlers();
    const addSpy = vi.spyOn(el, 'addEventListener');

    const detach = attachStylusRawTouch(el, () => handlers);
    el.dispatchEvent(touchEvent('touchstart', [stylusTouch()]));

    expect(addSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(() => detach()).not.toThrow();
  });
});
