// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useMultiSelectModifierHeld } from './useMultiSelectModifier';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('useMultiSelectModifierHeld', () => {
  let root: Root;
  let value = false;

  function Probe() {
    value = useMultiSelectModifierHeld();
    return null;
  }

  beforeEach(() => {
    root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
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
});
