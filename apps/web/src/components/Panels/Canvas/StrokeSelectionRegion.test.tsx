// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { StrokeSelectionRegion } from './StrokeSelectionRegion';

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: { domNode: HTMLElement | null }) => unknown) =>
    selector({
      domNode: document.querySelector<HTMLElement>('[data-rf-dom]'),
    }),
  useViewport: () => ({ x: 30, y: 40, zoom: 2 }),
}));

let host: HTMLDivElement | null = null;
let domNode: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  domNode = document.createElement('div');
  domNode.dataset.rfDom = '';
  document.body.append(host, domNode);
  root = createRoot(host);
  useGesturePreviewStore.setState({
    sketchSelectionPolygon: [
      { x: 10, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 50 },
      { x: 10, y: 50 },
    ],
    sketchStrokeMovePreview: { dx: 5, dy: -5 },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  host?.remove();
  domNode?.remove();
  host = null;
  domNode = null;
  root = null;
});

describe('StrokeSelectionRegion', () => {
  it('renders as a topmost screen-space HUD above the viewport renderer', () => {
    act(() => root?.render(<StrokeSelectionRegion />));

    const region = domNode?.querySelector<SVGSVGElement>(
      '[data-stroke-selection-region]',
    );
    if (!region) throw new Error('Expected retained Lasso HUD');

    expect(host?.querySelector('[data-stroke-selection-region]')).toBeNull();
    expect(region.classList.contains('z-999')).toBe(true);
    expect(region.style.left).toBe('60px');
    expect(region.style.top).toBe('70px');
    expect(region.style.width).toBe('40px');
    expect(region.style.height).toBe('60px');
    expect(region.getAttribute('viewBox')).toBe('0 0 20 30');
    expect(region.classList.contains('pointer-events-none')).toBe(true);
    expect(region.querySelector('polygon')?.style.pointerEvents).toBe('');
  });
});
