// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  useCanvasMultiSelectModifierHeld,
  useMultiSelectModifierHeld,
} from './useMultiSelectModifier';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('useMultiSelectModifierHeld', () => {
  let root: Root;
  let value = false;
  let canvasValue = false;
  let controls: HTMLDivElement;

  function Probe() {
    value = useMultiSelectModifierHeld();
    canvasValue = useCanvasMultiSelectModifierHeld();
    return null;
  }

  beforeEach(() => {
    controls = document.createElement('div');
    document.body.append(controls);
    root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    controls.remove();
  });

  it('recovers on pointer return when an OS shortcut consumes Meta keyup', () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    });
    expect(value).toBe(true);

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerdown'));
    });
    expect(value).toBe(false);
  });

  it('keeps chrome suppressed when the returning pointer still holds a modifier', () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { ctrlKey: true }));
    });
    expect(value).toBe(true);

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove'));
    });
    expect(value).toBe(false);
  });

  it.each(['input', 'textarea', 'button', 'select'])(
    'preserves focused %s controls without changing the raw modifier state',
    (tag) => {
      const control = document.createElement(tag);
      control.addEventListener('focusin', (event) => event.stopPropagation());
      control.addEventListener('focusout', (event) => event.stopPropagation());
      const canvas = document.createElement('div');
      canvas.tabIndex = -1;
      controls.append(control, canvas);
      act(() => {
        control.focus();
        control.dispatchEvent(
          new KeyboardEvent('keydown', { ctrlKey: true, bubbles: true }),
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', { ctrlKey: true }),
        );
      });
      expect(value).toBe(true);
      expect(canvasValue).toBe(false);
      act(() => canvas.focus());
      expect(canvasValue).toBe(true);
      act(() => control.focus());
      expect(canvasValue).toBe(false);
      act(() => window.dispatchEvent(new KeyboardEvent('keyup')));
      expect(value).toBe(false);
      expect(canvasValue).toBe(false);
    },
  );

  it('recovers canvas ownership when a focused control is removed without focusout', () => {
    const input = document.createElement('input');
    controls.append(input);
    act(() => {
      input.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
    });
    expect(canvasValue).toBe(false);
    act(() => {
      input.remove();
      window.dispatchEvent(new PointerEvent('pointermove', { ctrlKey: true }));
    });
    expect(value).toBe(true);
    expect(canvasValue).toBe(true);
  });
});
