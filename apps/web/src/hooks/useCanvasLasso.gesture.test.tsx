// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCanvasGestureForTests } from '@/handler/canvasGestureSession';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { createAreaSelectionSession } from './areaSelectionSession';
import { useCanvasLasso } from './useCanvasLasso';

import type { EffectiveInputMode } from '@/store/toolStore';
import type {
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  ReactFlowInstance,
  XYPosition,
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
  inputMode = 'mouse',
  native = false,
}: {
  active?: boolean;
  scopeKey?: string;
  inputMode?: EffectiveInputMode;
  native?: boolean;
}) {
  latest = useCanvasLasso({
    active,
    scopeKey,
    wrapperRef,
    rfInstanceRef: instanceRef,
    inputMode,
  });
  useEffect(() => {
    if (!native) return;
    const element = wrapper();
    const down = (event: PointerEvent) =>
      latest.pointerHandlers.onPointerDown(event);
    const move = (event: PointerEvent) =>
      latest.pointerHandlers.onPointerMove(event);
    const up = (event: PointerEvent) =>
      latest.pointerHandlers.onPointerUp(event);
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
    };
  }, [native]);
  return (
    <div
      ref={wrapperRef}
      className="react-flow__pane"
      {...(native ? {} : latest.pointerHandlers)}
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
  extra: PointerEventInit & {
    coalesced?: XYPosition[];
    target?: Element;
  } = {},
) {
  const { coalesced, target = wrapper(), ...init } = extra;
  const event = new PointerEvent(type, {
    bubbles: true,
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    ...init,
  });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: coalesced
      ? () =>
          coalesced.map(
            (point) =>
              new PointerEvent(type, {
                pointerId: event.pointerId,
                clientX: point.x,
                clientY: point.y,
              }),
          )
      : undefined,
  });
  act(() => target.dispatchEvent(event));
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
  useWorkspaceStore.setState({ worldCanvasId: null, spaceSummaries: {} });
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
    sketchSelectionSession: {},
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
  it.each(['note', 'image', 'sketch', 'frame'])(
    'starts inside a %s node and captures selection without moving it',
    (type) => {
      const node = document.createElement('div');
      node.className = `react-flow__node react-flow__node-${type}`;
      const surface = document.createElement('span');
      node.append(surface);
      wrapper().append(node);
      const positions = mocks.nodes.map((node) => node.position);
      dispatch('pointerdown', 0, 0, { target: surface });
      dispatch('pointermove', 80, 0);
      dispatch('pointermove', 80, 80);
      dispatch('pointermove', 0, 80);
      expect(latest.isActive).toBe(true);
      dispatch('pointerup', 0, 0);
      expect(selected()).toEqual(['note']);
      expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
        ink: ['inside'],
      });
      expect(mocks.nodes.map((node) => node.position)).toEqual(positions);
    },
  );

  it('retains a dense loop made entirely of sub-4px moves', () => {
    dispatch('pointerdown', 0, 0);
    for (let x = 2; x <= 80; x += 2) dispatch('pointermove', x, 0);
    for (let y = 2; y <= 80; y += 2) dispatch('pointermove', 80, y);
    for (let x = 78; x >= 0; x -= 2) dispatch('pointermove', x, 80);
    for (let y = 78; y >= 0; y -= 2) dispatch('pointermove', 0, y);
    dispatch('pointerup', 0, 0);
    expect(selected()).toEqual(['note']);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      ink: ['inside'],
    });
    expect(
      useGesturePreviewStore.getState().sketchSelectionPolygon,
    ).toHaveLength(161);
  });

  it.each([false, true])(
    'preserves coalesced concave turns and correct membership (native=%s)',
    (native) => {
      act(() => root.render(<Harness native={native} />));
      mocks.nodes.push({
        id: 'lobe',
        type: 'note',
        position: { x: 60, y: 30 },
        measured: { width: 5, height: 5 },
        data: {},
      });
      const points = [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 80 },
        { x: 50, y: 80 },
        { x: 50, y: 15 },
        { x: 15, y: 15 },
        { x: 15, y: 80 },
        { x: 0, y: 80 },
      ];
      const preview = vi.spyOn(
        useGesturePreviewStore.getState(),
        'setSketchStrokeSelection',
      );
      dispatch('pointerdown', 0, 0);
      dispatch('pointermove', 0, 80, { coalesced: points.slice(1) });
      expect(preview).toHaveBeenCalledTimes(1);
      expect(selected()).toEqual(['lobe']);
      expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual(
        {},
      );
      expect(latest.previewPath).toContain('L 50 15 L 15 15');
      dispatch('pointerup', 0, 80);
      expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual(
        points,
      );
      expect(mocks.select).toHaveBeenCalledExactlyOnceWith(['lobe']);
      preview.mockRestore();
    },
  );

  it.each(['missing', 'empty'] as const)(
    'uses dispatched coordinates when coalesced samples are %s',
    (support) => {
      dispatch('pointerdown', 0, 0);
      const extra = support === 'empty' ? { coalesced: [] } : {};
      dispatch('pointermove', 80, 0, extra);
      dispatch('pointermove', 80, 80, extra);
      dispatch('pointermove', 0, 80, extra);
      dispatch('pointerup', 1, 79);
      expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual([
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 80 },
        { x: 0, y: 80 },
        { x: 1, y: 79 },
      ]);
    },
  );

  it('locks on a coalesced excursion even when the endpoint returns to the start', () => {
    act(() => root.render(<Harness inputMode="finger" />));
    dispatch('pointerdown', 0, 0, { pointerType: 'touch' });
    dispatch('pointermove', 2, 1, { pointerType: 'touch' });
    expect(latest.isActive).toBe(false);
    expect(selected()).toEqual(['old']);
    dispatch('pointermove', 0, 0, {
      pointerType: 'touch',
      coalesced: [
        { x: 80, y: 0 },
        { x: 80, y: 80 },
        { x: 0, y: 80 },
      ],
    });
    expect(latest.isActive).toBe(true);
    dispatch('pointerup', 0, 0, { pointerType: 'touch' });
    expect(selected()).toEqual(['note']);
    expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      { x: 80, y: 0 },
      { x: 80, y: 80 },
      { x: 0, y: 80 },
      { x: 0, y: 0 },
    ]);
  });

  it('keeps sampled points aligned through auto-pan and ignores another pointer', () => {
    draw();
    dispatch('pointermove', 500, 500, { pointerId: 2 });
    act(() => latest.shiftScreenPoints(10, 20));
    dispatch('pointermove', 10, 100, { coalesced: [] });
    dispatch('pointerup', 10, 20);
    expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toEqual([
      { x: 10, y: 20 },
      { x: 90, y: 20 },
      { x: 90, y: 100 },
      { x: 10, y: 100 },
      { x: 10, y: 20 },
    ]);
  });

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

  it.each([false, true])(
    'filters cancelled selections using current hierarchy (strokeLevel=%s)',
    (strokeLevel) => {
      useWorkspaceStore.setState({
        worldCanvasId: 'canvas',
        spaceSummaries: { target: { parentSpaceId: null } },
      });
      mocks.nodes.push({
        id: 'entry',
        type: 'spacePreview',
        position: { x: 600, y: 600 },
        data: { targetCanvasId: 'target' },
        selected: true,
      });
      mocks.edges.push(
        { id: 'from-entry', source: 'entry', target: 'old', selected: true },
        { id: 'to-entry', source: 'old', target: 'entry', selected: true },
      );
      const session = createAreaSelectionSession(strokeLevel);
      session.preview(null);
      useWorkspaceStore.setState({
        spaceSummaries: { target: { parentSpaceId: 'parent' } },
      });
      session.cancel();
      expect(selected()).toEqual(['old']);
      expect(
        mocks.edges.filter((edge) => edge.selected).map((edge) => edge.id),
      ).toEqual(['old-edge']);
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it('selects nodes and strokes live, never a partially captured Frame or whole Sketch, and commits once', () => {
    const previousSession =
      useGesturePreviewStore.getState().sketchSelectionSession;
    draw();
    expect(useGesturePreviewStore.getState().sketchSelectionSession).toBe(
      previousSession,
    );
    expect(selected()).toEqual(['note']);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({
      ink: ['inside'],
    });
    expect(useGesturePreviewStore.getState().sketchSelectionPolygon).toBeNull();
    expect(mocks.flowState.userSelectionActive).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled();
    dispatch('pointerup', 0, 0);
    expect(useGesturePreviewStore.getState().sketchSelectionSession).not.toBe(
      previousSession,
    );
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
      expect(useGesturePreviewStore.getState().sketchSelectionSession).toBe(
        before.sketchSelectionSession,
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
    expect(useGesturePreviewStore.getState().sketchSelectionSession).toBeNull();
    expect(mocks.flowState.nodesSelectionActive).toBe(false);
  });

  it('clears both selection layers on an empty click', () => {
    dispatch('pointerdown', 400, 400);
    dispatch('pointerup', 400, 400);
    expect(selected()).toEqual([]);
    expect(useGesturePreviewStore.getState().sketchStrokeSelection).toEqual({});
    expect(useGesturePreviewStore.getState().sketchSelectionSession).toBeNull();
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
