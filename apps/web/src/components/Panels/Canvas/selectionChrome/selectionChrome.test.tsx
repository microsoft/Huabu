// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NODE_CONTROL_CHROME,
  NODE_RESIZE_GRIP_STYLE,
  NODE_SELECTION_CHROME,
} from '@/config/nodeInteractionChrome';

import { ResizeGrip } from './ResizeGrip';
import { SelectionOutline } from './SelectionOutline';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('selection chrome visual primitives', () => {
  it('shares stroke tokens without adding padding or layout borders', () => {
    const rect = { x: 15, y: 25, width: 300, height: 200 };
    act(() =>
      root.render(
        <>
          <SelectionOutline rect={rect} radius={18} />
          <SelectionOutline rect={rect} variant="dashed" />
        </>,
      ),
    );
    const [solid, dashed] = container.querySelectorAll<HTMLElement>(
      '[data-selection-outline]',
    );
    for (const outline of [solid, dashed]) {
      expect(outline.style.left).toBe('15px');
      expect(outline.style.top).toBe('25px');
      expect(outline.style.width).toBe('300px');
      expect(outline.style.height).toBe('200px');
      expect(outline.style.borderWidth).toBe('');
      expect(outline.style.padding).toBe('');
      expect(outline.style.pointerEvents).toBe('none');
      expect(outline.getAttribute('aria-hidden')).toBe('true');
    }
    expect(solid.style.borderRadius).toBe('18px');
    expect(solid.style.boxShadow).toBe(
      `0 0 0 ${NODE_SELECTION_CHROME.width}px ${NODE_SELECTION_CHROME.color}`,
    );
    expect(dashed.style.borderRadius).toBe('0px');
    const stroke = dashed.querySelector('rect');
    if (!stroke) throw new Error('Missing dashed selection stroke');
    expect(stroke.getAttribute('width')).toBe('300');
    expect(stroke.getAttribute('height')).toBe('200');
    expect(stroke.getAttribute('stroke')).toBe(NODE_SELECTION_CHROME.color);
    expect(stroke.getAttribute('stroke-width')).toBe(
      String(NODE_SELECTION_CHROME.width),
    );
    expect(stroke.getAttribute('stroke-dasharray')).toBe(
      NODE_SELECTION_CHROME.dashArray,
    );
  });

  it('preserves the collapsed mark outline offset and circular geometry', () => {
    // Happy DOM misparses outline shorthand containing CSS variables.
    const outlinePaint = vi.spyOn(
      CSSStyleDeclaration.prototype,
      'outline',
      'set',
    );
    act(() =>
      root.render(
        <SelectionOutline
          rect={{ x: 20, y: 30, width: 24, height: 24 }}
          radius={12}
          variant="offset"
          outlineOffset={2}
        />,
      ),
    );
    const outline = container.firstElementChild as HTMLElement;
    expect(outlinePaint).toHaveBeenCalledWith(
      `${NODE_SELECTION_CHROME.width}px solid ${NODE_SELECTION_CHROME.color}`,
    );
    expect(outline.style.outlineOffset).toBe('2px');
    expect(outline.style.borderRadius).toBe('12px');
    expect(outline.style.boxShadow).toBe('');
  });

  it.each([false, true])(
    'paints the same pointer-transparent grip with touch=%s',
    (isNotMouse) => {
      act(() => root.render(<ResizeGrip isNotMouse={isNotMouse} />));
      const grip = container.firstElementChild as HTMLElement;
      const size = NODE_CONTROL_CHROME.size[isNotMouse ? 'touch' : 'mouse'];
      expect(grip.style.width).toBe(`${size}px`);
      expect(grip.style.height).toBe(`${size}px`);
      expect(grip.style.backgroundColor).toBe(
        NODE_RESIZE_GRIP_STYLE.backgroundColor,
      );
      expect(grip.style.boxShadow).toBe(NODE_RESIZE_GRIP_STYLE.boxShadow);
      expect(grip.style.pointerEvents).toBe('none');
      expect(grip.getAttribute('aria-hidden')).toBe('true');
    },
  );
});
