// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { canScrollNote, containNoteWheel } from './noteScroll';

describe('Note scroll ownership', () => {
  const active = {
    selected: true,
    selectedCount: 1,
    fixed: true,
    bodyVisible: true,
    missing: false,
  };
  it('allows only a sole-selected fixed Note with a visible document body', () => {
    expect(canScrollNote(active)).toBe(true);
    for (const change of [
      { selected: false },
      { selectedCount: 0 },
      { selectedCount: 2 },
      { fixed: false },
      { bodyVisible: false },
      { missing: true },
    ]) {
      expect(canScrollNote({ ...active, ...change })).toBe(false);
    }
  });
  it('contains native wheel at both edges without cancelling scrolling', () => {
    const parent = document.createElement('div');
    const viewport = document.createElement('div');
    parent.append(viewport);
    Object.defineProperties(viewport, {
      scrollHeight: { value: 300 },
      clientHeight: { value: 100 },
    });
    const bubbled = vi.fn();
    parent.addEventListener('wheel', bubbled);
    viewport.addEventListener('wheel', containNoteWheel, { capture: true });
    for (const top of [0, 200]) {
      viewport.scrollTop = top;
      const event = new WheelEvent('wheel', {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      });
      viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(bubbled).not.toHaveBeenCalled();
    for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true });
      // Happy DOM's WheelEvent does not initialize inherited modifiers.
      Object.defineProperty(event, key, { value: true });
      viewport.dispatchEvent(event);
    }
    expect(bubbled).toHaveBeenCalledTimes(4);
  });
  it('leaves fitting documents canvas-owned', () => {
    const viewport = document.createElement('div');
    Object.defineProperties(viewport, {
      scrollHeight: { value: 100 },
      clientHeight: { value: 100 },
    });
    const event = new WheelEvent('wheel');
    Object.defineProperty(event, 'currentTarget', { value: viewport });
    const stop = vi.spyOn(event, 'stopPropagation');
    containNoteWheel(event);
    expect(stop).not.toHaveBeenCalled();
  });
});
