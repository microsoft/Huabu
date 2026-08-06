// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import {
  hasHorizontalScrollAncestor,
  resolveSwipeAxis,
  resolveSwipeDirection,
} from './swipeNavigation';

// `getComputedStyle` only resolves for elements in the document.
function mount(el: HTMLElement) {
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

function scrollableDiv(scrollWidth: number, clientWidth: number) {
  const el = document.createElement('div');
  el.style.overflowX = 'auto';
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth });
  return el;
}

describe('resolveSwipeDirection', () => {
  it('reads a leftward swipe as moving downstream', () => {
    expect(resolveSwipeDirection(-120, 10, 200)).toBe('outgoing');
  });

  it('reads a rightward swipe as moving upstream', () => {
    expect(resolveSwipeDirection(120, -10, 200)).toBe('incoming');
  });

  it('ignores drags that are too short', () => {
    expect(resolveSwipeDirection(-20, 0, 200)).toBeNull();
  });

  it('ignores drags that are mostly vertical', () => {
    expect(resolveSwipeDirection(-120, 100, 200)).toBeNull();
  });

  it('ignores slow drags that read as scrolling', () => {
    expect(resolveSwipeDirection(-120, 10, 2000)).toBeNull();
  });
});

describe('resolveSwipeAxis', () => {
  it('waits for enough travel before committing', () => {
    expect(resolveSwipeAxis(-8, 2)).toBeNull();
  });

  it('claims a drag that leans horizontal', () => {
    expect(resolveSwipeAxis(-20, 8)).toBe('horizontal');
  });

  it('releases a drag that leans vertical', () => {
    expect(resolveSwipeAxis(-8, 20)).toBe('vertical');
  });
});

describe('hasHorizontalScrollAncestor', () => {
  it('yields the gesture to a horizontally scrollable ancestor', () => {
    const boundary = mount(document.createElement('div'));
    const table = scrollableDiv(800, 300);
    const cell = document.createElement('span');
    table.appendChild(cell);
    boundary.appendChild(table);

    expect(hasHorizontalScrollAncestor(cell, boundary)).toBe(true);
  });

  it('keeps the gesture when nothing scrolls sideways', () => {
    const boundary = mount(document.createElement('div'));
    const inner = document.createElement('span');
    boundary.appendChild(inner);

    expect(hasHorizontalScrollAncestor(inner, boundary)).toBe(false);
  });

  it('stops looking above the panel body', () => {
    const outer = mount(scrollableDiv(800, 300));
    const boundary = document.createElement('div');
    const inner = document.createElement('span');
    boundary.appendChild(inner);
    outer.appendChild(boundary);

    expect(hasHorizontalScrollAncestor(inner, boundary)).toBe(false);
  });
});
