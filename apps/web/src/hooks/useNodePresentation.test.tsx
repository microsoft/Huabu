// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNodePresentation } from './useNodePresentation';

const fixture = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  node: {
    selected: false,
    hidden: false,
    style: { width: 600, height: 400 },
    measured: { width: 400, height: 200 },
    internals: { positionAbsolute: { x: 100, y: 100 } },
  },
  selectedCount: 0,
}));
vi.mock('@xyflow/react', () => ({
  useViewport: () => fixture.viewport,
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      nodeLookup: new Map([['node', fixture.node]]),
      width: 1000,
      height: 800,
      transform: [
        fixture.viewport.x,
        fixture.viewport.y,
        fixture.viewport.zoom,
      ],
      nodes: Array.from({ length: fixture.selectedCount }, () => ({
        selected: true,
      })),
    }),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('useNodePresentation', () => {
  let root: Root;
  let element: HTMLDivElement;
  let result: ReturnType<typeof useNodePresentation>;
  function Probe({ type }: { type: string }) {
    result = useNodePresentation('node', type);
    return null;
  }
  function render(type = 'pdf') {
    act(() => root.render(<Probe type={type} />));
  }
  beforeEach(() => {
    fixture.viewport = { x: 0, y: 0, zoom: 1 };
    fixture.node.style = { width: 600, height: 400 };
    fixture.node.internals.positionAbsolute = { x: 100, y: 100 };
    fixture.node.selected = false;
    fixture.node.hidden = false;
    fixture.selectedCount = 0;
    element = document.createElement('div');
    root = createRoot(element);
  });
  afterEach(() => act(() => root.unmount()));

  it('uses live geometry and screen zoom, not stale measured dimensions', () => {
    render();
    expect(result.mode).toBe('reading');
    fixture.viewport.zoom = 0.5;
    render();
    expect(result.mode).toBe('overview');
    fixture.viewport.zoom = 0.19;
    render();
    expect(result.mode).toBe('minimal');
  });
  it('gates visibility by absolute nested-node position, viewport and hidden state', () => {
    render();
    expect(result.isVisible).toBe(true);
    fixture.node.internals.positionAbsolute.x = 1200;
    render();
    expect(result.isVisible).toBe(false);
    fixture.viewport.x = -1000;
    render();
    expect(result.isVisible).toBe(true);
    fixture.node.hidden = true;
    render();
    expect(result.isVisible).toBe(false);
  });
  it('changes interaction ownership without changing the content layer', () => {
    render();
    expect(result.isSoleSelected).toBe(false);
    fixture.node.selected = true;
    fixture.selectedCount = 1;
    render();
    expect(result.isSoleSelected).toBe(true);
    expect(result.mode).toBe('reading');
    fixture.selectedCount = 2;
    render();
    expect(result.isSoleSelected).toBe(false);
    expect(result.mode).toBe('reading');
  });
  it('does not opt other node types into layered rendering', () => {
    fixture.viewport.zoom = 0.1;
    render('frame');
    expect(result.mode).toBe('overview');
  });
  it('keeps videos in ordinary mode at any size, with the shared far-zoom hysteresis', () => {
    fixture.node.style = { width: 2400, height: 1600 };
    render('video');
    expect(result.mode).toBe('overview');
    for (const [zoom, mode] of [
      [0.24, 'minimal'],
      [0.27, 'minimal'],
      [0.3, 'overview'],
    ] as const) {
      fixture.viewport.zoom = zoom;
      render('video');
      expect(result.mode).toBe(mode);
    }
  });
  it('uses the same zoom band for short Notes and cards', () => {
    fixture.node.style = { width: 400, height: 80 };
    for (const [zoom, expected] of [
      [0.5, 'overview'],
      [0.25, 'overview'],
      [0.24, 'minimal'],
      [0.27, 'minimal'],
      [0.3, 'overview'],
    ] as const) {
      fixture.viewport.zoom = zoom;
      render('note');
      expect(result.mode).toBe(expected);
    }
    render('pdf');
    expect(result.mode).toBe('overview');
  });
});
