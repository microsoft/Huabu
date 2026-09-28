// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { useSketchHoverRouting } from './useSketchHoverRouting';

import type { ReactFlowInstance } from '@xyflow/react';

vi.mock('@/components/Nodes/sketch/sketchHitTest', () => ({
  findSketchHits: () => ({ hits: ['sketch-1'], topmost: 'sketch-1' }),
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const instance = {
  screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  getZoom: () => 1,
} as ReactFlowInstance;

function Harness() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance>(instance);
  useSketchHoverRouting(wrapperRef, instanceRef);

  return (
    <div ref={wrapperRef} data-testid="wrapper">
      <div className="react-flow__node" data-id="sketch-1" />
    </div>
  );
}

function pointerDown(pointerType: 'mouse' | 'touch'): Event {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: 10 },
    clientY: { value: 20 },
    pointerType: { value: pointerType },
  });
  return event;
}

beforeEach(() => {
  useCanvasStore.getState()._setStateNoAutosave({
    nodes: [
      {
        id: 'sketch-1',
        type: 'sketch',
        position: { x: 0, y: 0 },
        data: {},
      },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  vi.restoreAllMocks();
  host?.remove();
  host = null;
  root = null;
});

describe('useSketchHoverRouting', () => {
  it('restores hover after a descendant consumes pointerup', () => {
    const wrapper = host?.querySelector<HTMLElement>('[data-testid="wrapper"]');
    const sketch = host?.querySelector<HTMLElement>('[data-id="sketch-1"]');
    if (!wrapper || !sketch) throw new Error('Expected mounted Sketch harness');
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    sketch.addEventListener('pointerup', (event) => event.stopPropagation());

    act(() => {
      sketch.dispatchEvent(pointerDown('mouse'));
      sketch.dispatchEvent(new Event('pointerup', { bubbles: true }));
      wrapper.dispatchEvent(new Event('pointerleave'));
      wrapper.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: 10,
          clientY: 20,
          buttons: 0,
        }),
      );
      frame?.(0);
    });

    expect(sketch.getAttribute('data-sketch-hover')).toBe('true');
  });

  it('does not activate or select a Sketch for touch input', () => {
    const wrapper = host?.querySelector<HTMLElement>('[data-testid="wrapper"]');
    const sketch = host?.querySelector<HTMLElement>('[data-id="sketch-1"]');
    if (!wrapper || !sketch) throw new Error('Expected mounted Sketch harness');

    act(() => wrapper.dispatchEvent(pointerDown('touch')));

    expect(sketch.hasAttribute('data-sketch-hover')).toBe(false);
    expect(useCanvasStore.getState().nodes[0]?.selected).not.toBe(true);
  });

  it('keeps geometric hover activation for mouse input', () => {
    const wrapper = host?.querySelector<HTMLElement>('[data-testid="wrapper"]');
    const sketch = host?.querySelector<HTMLElement>('[data-id="sketch-1"]');
    if (!wrapper || !sketch) throw new Error('Expected mounted Sketch harness');

    act(() => wrapper.dispatchEvent(pointerDown('mouse')));

    expect(sketch.getAttribute('data-sketch-hover')).toBe('true');
  });
});
