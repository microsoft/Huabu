// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNodeTakeover } from './useNodeTakeover';

import type { NodeTakeoverGeometry } from './useNodeTakeover';

const flow = vi.hoisted(() => ({
  viewport: { x: 10, y: 20, zoom: 0.1 },
  node: {
    type: 'question',
    style: { width: 440, height: 200 },
    data: { style: { fontSize: 56 } },
    internals: { positionAbsolute: { x: 100, y: 200 } },
  },
}));
vi.mock('@xyflow/react', () => ({
  useViewport: () => flow.viewport,
  useInternalNode: () => flow.node,
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ nodeLookup: new Map([['q', flow.node]]) }),
}));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  flow.viewport = { x: 10, y: 20, zoom: 0.1 };
  flow.node.style = { width: 440, height: 200 };
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('useNodeTakeover', () => {
  it('uses 75% of the shorter card dimension and keeps anchors stable across pan and zoom', () => {
    let geometry: NodeTakeoverGeometry | undefined;
    function Probe() {
      geometry = useNodeTakeover('q', 0.75, 48);
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe />));
    expect(geometry).toMatchObject({
      stage: 'collapsed',
      collapsedCenter: { x: 320, y: 300 },
      point: { x: 42, y: 50 },
      glideProgress: 1,
    });
    expect(geometry!.size * 0.66).toBeCloseTo(15);
    expect(geometry!.collapsedRadius).toBeCloseTo(((150 / 0.66) * 0.75) / 2);
    const anchors = {
      center: geometry!.collapsedCenter,
      radius: geometry!.collapsedRadius,
    };
    flow.viewport = { x: -23456.789, y: 54321.987, zoom: 0.05 };
    act(() => root!.render(<Probe />));
    expect(geometry!.size * 0.66).toBeCloseTo(7.5);
    expect({
      center: geometry!.collapsedCenter,
      radius: geometry!.collapsedRadius,
    }).toEqual(anchors);
    expect(flow.node.style).toEqual({ width: 440, height: 200 });
    expect(flow.node.data.style.fontSize).toBe(56);
    flow.node.style = { width: 440, height: 100 };
    act(() => root!.render(<Probe />));
    expect(geometry!.size * 0.66).toBeCloseTo(3.75);
    flow.node.style = { width: 80, height: 200 };
    act(() => root!.render(<Probe />));
    expect(geometry!.size * 0.66).toBeCloseTo(3);
  });
  it('follows live displayed font changes without changing the viewport or node data', () => {
    flow.viewport.zoom = 0.2;
    let geometry: NodeTakeoverGeometry | undefined;
    function Probe({ fontSize }: { fontSize: number }) {
      geometry = useNodeTakeover('q', undefined, fontSize);
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe fontSize={48} />));
    expect(geometry!.stage).toBe('readable');
    act(() => root!.render(<Probe fontSize={24} />));
    expect(geometry!.stage).toBe('collapsed');
    act(() => root!.render(<Probe fontSize={26} />));
    expect(geometry!.stage).toBe('collapsed');
    act(() => root!.render(<Probe fontSize={27.5} />));
    expect(geometry!.stage).toBe('readable');
    expect(flow.viewport.zoom).toBe(0.2);
    expect(flow.node.data.style.fontSize).toBe(56);
  });
  it('forces the Frame dot without overwriting the font-stage hysteresis', () => {
    flow.viewport.zoom = 0.14;
    let geometry: NodeTakeoverGeometry | undefined;
    function Probe({ suppressed }: { suppressed: boolean }) {
      geometry = useNodeTakeover('q', undefined, 48, suppressed);
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe suppressed={false} />));
    expect(geometry!.stage).toBe('readable');
    act(() => root!.render(<Probe suppressed />));
    expect(geometry!.stage).toBe('collapsed');
    act(() => root!.render(<Probe suppressed={false} />));
    expect(geometry!.stage).toBe('readable');
  });
});
