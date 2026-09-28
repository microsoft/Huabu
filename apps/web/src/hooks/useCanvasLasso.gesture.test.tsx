// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCanvasGestureForTests } from '@/handler/canvasGestureSession';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { createAreaSelectionSession } from './areaSelectionSession';
import { useCanvasLasso } from './useCanvasLasso';

import type {
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  ReactFlowInstance,
} from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  nodes: [] as Node[],
  edges: [] as Edge[],
  canvasId: 'canvas',
  select: vi.fn(),
  flowState: { userSelectionActive: false, nodesSelectionActive: true },
}));
vi.mock('@xyflow/react', () => {
  const flow = {
    getState: () => mocks.flowState,
    setState: (patch: Partial<typeof mocks.flowState>) =>
      Object.assign(mocks.flowState, patch),
  };
  return { useStoreApi: () => flow };
});
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({
      canvasId: mocks.canvasId,
      nodes: mocks.nodes,
      edges: mocks.edges,
      selectNodes: mocks.select,
      onNodesChange: (changes: NodeChange[]) => {
        for (const change of changes) {
          if (change.type === 'select')
            mocks.nodes = mocks.nodes.map((node) =>
              node.id === change.id
                ? { ...node, selected: change.selected }
                : node,
            );
        }
      },
      onEdgesChange: (changes: EdgeChange[]) => {
        for (const change of changes) {
          if (change.type === 'select')
            mocks.edges = mocks.edges.map((edge) =>
              edge.id === change.id
                ? { ...edge, selected: change.selected }
                : edge,
            );
        }
      },
    }),
  },
}));

let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useCanvasLasso>;
const wrapperRef = { current: null as HTMLDivElement | null };
const instanceRef = {
  current: {
    screenToFlowPosition: (point) => point,
  } as ReactFlowInstance,
};

function Harness({
  active = true,
  scopeKey = 'canvas',
}: {
  active?: boolean;
  scopeKey?: string;
}) {
  latest = useCanvasLasso({
    active,
    scopeKey,
    wrapperRef,
    rfInstanceRef: instanceRef,
    inputMode: 'mouse',
  });
  return (
    <div
      ref={wrapperRef}
      className="react-flow__pane"
      {...latest.pointerHandlers}
    />
  );
}
function wrapper() {
  if (!wrapperRef.current) throw new Error('Lasso wrapper is not mounted');
  return wrapperRef.current;
}

function dispatch(
  type: string,
  x: number,
  y: number,
  extra: PointerEventInit = {},
) {
  act(() =>
    wrapper().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        ...extra,
      }),
    ),
  );
}
function draw() {
  dispatch('pointerdown', 0, 0);
  dispatch('pointermove', 80, 0);
  dispatch('pointermove', 80, 80);
  dispatch('pointermove', 0, 80);
}
function selected() {
  return mocks.nodes.filter((node) => node.selected).map((node) => node.id);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetCanvasGestureForTests();
  vi.clearAllMocks();
  mocks.canvasId = 'canvas';
  mocks.flowState = { userSelectionActive: false, nodesSelectionActive: true };
  mocks.nodes = [
    {
      id: 'frame',
      type: 'frame',
      position: { x: 10, y: 10 },
      measured: { width: 200, height: 200 },
      data: {},
    },
    {
      id: 'note',
      type: 'note',
      position: { x: 20, y: 20 },
      measured: { width: 20, height: 20 },
      data: {},
    },
    {
      id: 'old',
      type: 'note',
      position: { x: 500, y: 500 },
      measured: { width: 20, height: 20 },
      selected: true,
      data: {},
    },
    {
      id: 'ink',
      type: 'sketch',
      position: { x: 0, y: 0 },
      measured: { width: 100, height: 100 },
      data: {
        initialSize: { width: 100, height: 100 },
        strokes: [
          { id: 'inside', points: [[30, 30]], size: 2 },
          { id: 'outside', points: [[90, 90]], size: 2 },
        ],
      },
    },
  ];
  mocks.edges = [
    { id: 'old-edge', source: 'old', target: 'frame', selected: true },
    { id: 'new-edge', source: 'note', target: 'frame' },
  ];
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { ink: ['outside'] },
    sketchSelectionPolygon: [
      { x: 85, y: 85 },
      { x: 100, y: 85 },
      { x: 100, y: 100 },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
  let captured: number | null = null;
  wrapper().setPointerCapture = (id) => {
    captured = id;
  };
  wrapper().hasPointerCapture = (id) => captured === id;
  wrapper().releasePointerCapture = () => {
    captured = null;
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('lasso shared selection lifecycle', () => {
  it('keeps rectangle Sketch selection at whole-node granularity through the same session', () => {
    useGesturePreviewStore.getState().clearSketchStrokeSelection();
    const session = createAreaSelectionSession();
    session.commit({
      kind: 'rectangle',
      rect: { x: 0, y: 0, width: 80, height: 80 },
    });
    expect(selected()).toEqual(['note', 'ink']);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(['note', 'ink']);
  });

  it('suppresses the trailing click after cancellation but allows the next real press', () => {
    const onClick = vi.fn();
    wrapper().addEventListener('click', onClick);
    draw();
    dispatch('pointercancel', 0, 80);
    act(() =>
      wrapper().dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      ),
    );
    expect(onClick).not.toHaveBeenCalled();
    dispatch('pointerdown', 400, 400);
    dispatch('pointerup', 400, 400);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith([]);
    wrapper().removeEventListener('click', onClick);
  });

  it('leaves pending selection untouched and restores it after cancellation', () => {
    dispatch('pointerdown', 0, 0);
    expect(selected()).toEqual(['old']);
    dispatch('pointercancel', 0, 0);
    expect(selected()).toEqual(['old']);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('selects nodes and strokes live, never a partially captured Frame or whole Sketch, and commits once', () => {
    draw();
    expect(selected()).toEqual(['note']);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      ink: ['inside'],
    });
    expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toBeNull();
    expect(mocks.flowState.userSelectionActive).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled();
    dispatch('pointerup', 0, 0);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(['note']);
    expect(
      useGesturePreviewStore.getState().sketchSelectionPolygon,
    ).not.toBeNull();
    expect(mocks.flowState.userSelectionActive).toBe(false);
    expect(latest.isActive).toBe(false);
  });

  it.each([
    'escape',
    'pointercancel',
    'blur',
    'lostcapture',
    'buttons',
    'disable',
    'unmount',
  ])(
    'restores node, edge, ink and retained region selection on %s',
    (reason) => {
      const before = useGesturePreviewStore.getState();
      draw();
      act(() => {
        if (reason === 'escape')
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        if (reason === 'blur') window.dispatchEvent(new Event('blur'));
        if (reason === 'lostcapture')
          wrapper().dispatchEvent(
            new PointerEvent('lostpointercapture', { pointerId: 1 }),
          );
        if (reason === 'disable') root.render(<Harness active={false} />);
        if (reason === 'unmount') root.render(null);
      });
      if (reason === 'pointercancel') dispatch('pointercancel', 0, 80);
      if (reason === 'buttons') dispatch('pointermove', 0, 80, { buttons: 0 });
      expect(selected()).toEqual(['old']);
      expect(
        mocks.edges.filter((edge) => edge.selected).map((edge) => edge.id),
      ).toEqual(['old-edge']);
      expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual(
        before.sketchStrokeSelection,
      );
      expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual(
        before.sketchSelectionPolygon,
      );
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.flowState.userSelectionActive).toBe(false);
    },
  );

  it('does not restore old IDs or Ink when changing canvases', () => {
    draw();
    mocks.canvasId = 'next';
    mocks.nodes = [];
    useGesturePreviewStore.getState().resetCanvasScopedTransients();
    act(() => root.render(<Harness scopeKey="next" />));
    expect(selected()).toEqual([]);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(mocks.flowState.nodesSelectionActive).toBe(false);
  });

  it('clears both selection layers on an empty click', () => {
    dispatch('pointerdown', 400, 400);
    dispatch('pointerup', 400, 400);
    expect(selected()).toEqual([]);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('does not take over an Ink selection reserved by submission preparation', () => {
    useGesturePreviewStore.getState().setInkSubmissionPreparing(true);
    draw();
    dispatch('pointerup', 0, 0);
    expect(selected()).toEqual(['old']);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
