// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCanvasGesture,
  resetCanvasGestureForTests,
} from '@/handler/canvasGestureSession';
import { PointerRouterCore } from '@/handler/pointerRouter';

import { useCanvasMarquee } from './useCanvasMarquee';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type {
  Edge,
  Node,
  NodeChange,
  EdgeChange,
  ReactFlowInstance,
  ReactFlowState,
} from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  nodes: [] as Node[],
  edges: [] as Edge[],
  available: true,
  select: vi.fn(),
  nodeChanges: vi.fn(),
  edgeChanges: vi.fn(),
  viewport: vi.fn(),
  active: vi.fn(),
  flow: null as unknown as {
    getState: () => ReactFlowState;
    setState: (patch: Partial<ReactFlowState>) => void;
    subscribe: (
      listener: (s: ReactFlowState, p: ReactFlowState) => void,
    ) => () => void;
  },
}));
vi.mock('@xyflow/react', () => ({ useStoreApi: () => mocks.flow }));
vi.mock('@/handler/canvasInteractionOwner', () => ({
  canTouchClaimViewport: () => mocks.available,
}));
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({
      nodes: mocks.nodes,
      edges: mocks.edges,
      onNodesChange: mocks.nodeChanges,
      onEdgesChange: mocks.edgeChanges,
      selectNodes: mocks.select,
      setViewport: mocks.viewport,
    }),
  },
}));

let root: Root;
let wrapper: HTMLDivElement;
let pane: HTMLDivElement;
let frame: HTMLDivElement;
let core: PointerRouterCore<PointerEvent, CanvasPointerRouterContext>;
let context: CanvasPointerRouterContext;
let instance: ReactFlowInstance;
let flowState: ReactFlowState;
let captured: number | null;
let latest: ReturnType<typeof useCanvasMarquee>;
let rafs: Map<number, FrameRequestCallback>;
const wrapperRef = { current: null as HTMLDivElement | null };
const instanceRef = { current: null as ReactFlowInstance | null };

function Harness({
  enabled = true,
  scopeKey = 'canvas',
}: {
  enabled?: boolean;
  scopeKey?: string;
}) {
  latest = useCanvasMarquee({
    enabled,
    scopeKey,
    wrapperRef,
    rfInstanceRef: instanceRef,
    onActiveChange: mocks.active,
  });
  return null;
}
function selected() {
  return mocks.nodes.filter((n) => n.selected).map((n) => n.id);
}
function dispatch(
  type: string,
  x = 150,
  y = 150,
  extra: PointerEventInit = {},
  target: Element = frame,
) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    ...extra,
  });
  act(() => target.dispatchEvent(event));
  return event;
}
function tick() {
  const callbacks = [...rafs.values()];
  rafs.clear();
  act(() => callbacks.forEach((callback) => callback(100)));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  resetCanvasGestureForTests();
  mocks.available = true;
  mocks.nodes = [
    {
      id: 'frame',
      type: 'frame',
      position: { x: 100, y: 100 },
      style: { width: 300, height: 300 },
      data: {},
    },
    {
      id: 'child',
      type: 'note',
      parentId: 'frame',
      position: { x: 100, y: 100 },
      style: { width: 50, height: 50 },
      data: {},
    },
    {
      id: 'old',
      type: 'note',
      position: { x: 700, y: 700 },
      style: { width: 30, height: 30 },
      selected: true,
      data: {},
    },
  ];
  mocks.edges = [
    { id: 'edge', source: 'child', target: 'old', selected: true },
  ];
  mocks.nodeChanges.mockImplementation((changes: NodeChange[]) => {
    for (const c of changes)
      if (c.type === 'select')
        mocks.nodes = mocks.nodes.map((n) =>
          n.id === c.id ? { ...n, selected: c.selected } : n,
        );
  });
  mocks.edgeChanges.mockImplementation((changes: EdgeChange[]) => {
    for (const c of changes)
      if (c.type === 'select')
        mocks.edges = mocks.edges.map((e) =>
          e.id === c.id ? { ...e, selected: c.selected } : e,
        );
  });
  mocks.select.mockImplementation((ids: string[], toggle = false) => {
    mocks.nodes = mocks.nodes.map((n) => ({
      ...n,
      selected: toggle
        ? ids.includes(n.id)
          ? !n.selected
          : n.selected
        : ids.includes(n.id),
    }));
  });
  flowState = {
    transform: [0, 0, 1],
    userSelectionActive: false,
    userSelectionRect: null,
    nodesSelectionActive: true,
    panZoom: { syncViewport: vi.fn() },
  } as unknown as ReactFlowState;
  const listeners = new Set<(s: ReactFlowState, p: ReactFlowState) => void>();
  mocks.flow = {
    getState: () => flowState,
    setState: (patch) => {
      const previous = flowState;
      flowState = { ...flowState, ...patch };
      for (const listener of listeners) listener(flowState, previous);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  instance = {
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: (x - flowState.transform[0]) / flowState.transform[2],
      y: (y - flowState.transform[1]) / flowState.transform[2],
    }),
    flowToScreenPosition: ({ x, y }: { x: number; y: number }) => ({
      x: x * flowState.transform[2] + flowState.transform[0],
      y: y * flowState.transform[2] + flowState.transform[1],
    }),
    getViewport: () => ({
      x: flowState.transform[0],
      y: flowState.transform[1],
      zoom: flowState.transform[2],
    }),
  } as ReactFlowInstance;
  instanceRef.current = instance;
  wrapper = document.createElement('div');
  wrapper.tabIndex = -1;
  document.body.append(wrapper);
  wrapperRef.current = wrapper;
  wrapper.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 800,
    width: 800,
    height: 800,
    toJSON() {},
  });
  captured = null;
  wrapper.setPointerCapture = (id) => {
    captured = id;
  };
  wrapper.hasPointerCapture = (id) => captured === id;
  wrapper.releasePointerCapture = (id) => {
    captured = null;
    wrapper.dispatchEvent(
      new PointerEvent('lostpointercapture', { pointerId: id }),
    );
  };
  rafs = new Map();
  let nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafs.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id));
  const host = document.createElement('div');
  wrapper.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
  pane = document.createElement('div');
  pane.className = 'react-flow__pane';
  wrapper.append(pane);
  frame = document.createElement('div');
  frame.className = 'react-flow__node react-flow__node-frame';
  frame.dataset.id = 'frame';
  pane.append(frame);
  context = {
    wrapper,
    instance,
    inputMode: 'mouse',
    interactivityLocked: false,
    explicitToolActive: false,
    onTouchTakeover: vi.fn(),
    onEmptyCanvasTap: vi.fn(),
    onNodeTap: vi.fn(),
  };
  core = new PointerRouterCore([latest.recognizer], () => context);
  wrapper.addEventListener('pointerdown', (e) => core.handleDown(e), true);
  wrapper.addEventListener('pointermove', (e) => core.handleMove(e), true);
  wrapper.addEventListener('pointerup', (e) => core.handleUp(e), true);
  wrapper.addEventListener('pointercancel', (e) => core.handleCancel(e), true);
  wrapper.addEventListener(
    'lostpointercapture',
    (e) => core.handleCancel(e),
    true,
  );
});
afterEach(() => {
  act(() => root.unmount());
  wrapper.remove();
  resetCanvasGestureForTests();
  vi.unstubAllGlobals();
});

describe('mouse rectangle owner', () => {
  it('replaces retained child selections from another Frame only on activation, and Escape restores the full set', () => {
    mocks.nodes = [
      ...mocks.nodes,
      {
        id: 'other-frame',
        type: 'frame',
        position: { x: 600, y: 600 },
        data: {},
      },
      {
        id: 'other-child',
        type: 'note',
        parentId: 'other-frame',
        position: { x: 20, y: 20 },
        data: {},
        selected: true,
      },
    ].map((n) => (n.id === 'old' ? { ...n, parentId: 'other-frame' } : n));
    const before = mocks.nodes.map(({ selected: _selected, ...n }) => n);
    for (let attempt = 0; attempt < 2; attempt++) {
      dispatch('pointerdown');
      dispatch('pointermove', 150.5, 150);
      expect(selected()).toEqual(['old', 'other-child']);
      expect(flowState.nodesSelectionActive).toBe(true);
      dispatch('pointermove', 225, 225);
      expect(selected()).toEqual(['child']);
      expect(flowState.nodesSelectionActive).toBe(false);
      act(() =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
        ),
      );
      expect(selected()).toEqual(['old', 'other-child']);
      expect(flowState.nodesSelectionActive).toBe(true);
      dispatch('pointerup');
    }
    expect(mocks.nodes.map(({ selected: _selected, ...n }) => n)).toEqual(
      before,
    );
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('does not select at down; below threshold click selects the Frame and suppresses native mousedown/click', () => {
    expect(dispatch('pointerdown').defaultPrevented).toBe(true);
    expect(selected()).toEqual(['old']);
    const nativeDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    frame.dispatchEvent(nativeDown);
    expect(nativeDown.defaultPrevented).toBe(true);
    dispatch('pointermove', 150.99, 150);
    expect(flowState.userSelectionActive).toBe(false);
    dispatch('pointerup', 150.99, 150);
    expect(selected()).toEqual(['frame']);
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(flowState.nodesSelectionActive).toBe(false);
    expect(getCanvasGesture()).toBeNull();
    expect(captured).toBeNull();
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    frame.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
  it('activates at exactly 1 screen px and only sends selection changes', () => {
    dispatch('pointerdown');
    dispatch('pointermove', 151, 150);
    expect(getCanvasGesture()?.phase).toBe('locked');
    expect(flowState.userSelectionActive).toBe(true);
    expect(selected()).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(
      mocks.nodeChanges.mock.calls.flat(2).every((c) => c.type === 'select'),
    ).toBe(true);
  });
  it.each([0.5, 1, 2])(
    'shows live child selection and excludes Frame while dragging inside it at zoom %s',
    (zoom) => {
      act(() => mocks.flow.setState({ transform: [0, 0, zoom] }));
      dispatch('pointerdown', 150 * zoom, 150 * zoom);
      dispatch('pointermove', 225 * zoom, 225 * zoom);
      expect(selected()).toEqual(['child']);
      expect(mocks.select).not.toHaveBeenCalled();
      dispatch('pointerup', 225 * zoom, 225 * zoom);
      expect(selected()).toEqual(['child']);
      expect(mocks.select).toHaveBeenLastCalledWith(['child']);
      expect(flowState.nodesSelectionActive).toBe(true);
      expect(flowState.userSelectionRect).toBeNull();
    },
  );
  it('pane rectangle toggles Frame live containment and retains Frame+children on end', () => {
    dispatch('pointerdown', 50, 50, {}, pane);
    dispatch('pointermove', 400, 400);
    expect(selected()).toEqual(['frame', 'child']);
    dispatch('pointermove', 399, 400);
    expect(selected()).toEqual(['child']);
    dispatch('pointermove', 400, 400);
    expect(selected()).toEqual(['frame', 'child']);
    dispatch('pointerup', 400, 400);
    expect(selected()).toEqual(['frame', 'child']);
  });
  it('freezes start eligibility before any later selection update', () => {
    dispatch('pointerdown');
    mocks.nodes = mocks.nodes.map((n) => ({
      ...n,
      selected: n.id === 'frame',
    }));
    dispatch('pointermove', 225, 225);
    expect(selected()).toEqual(['child']);
  });

  it('nested unselected Frame starts the same rectangle and a selected nested Frame stays native', () => {
    mocks.nodes = [
      ...mocks.nodes,
      {
        id: 'nested',
        type: 'frame',
        parentId: 'frame',
        position: { x: 40, y: 40 },
        style: { width: 140, height: 140 },
        data: {},
      },
    ];
    const nested = document.createElement('div');
    nested.className = 'react-flow__node react-flow__node-frame';
    nested.dataset.id = 'nested';
    frame.append(nested);
    dispatch('pointerdown', 160, 160, {}, nested);
    dispatch('pointermove', 225, 225);
    expect(selected()).toEqual(['child']);
    dispatch('pointerup', 225, 225);
    mocks.nodes = mocks.nodes.map((n) => ({
      ...n,
      selected: n.id === 'nested',
    }));
    expect(dispatch('pointerdown', 160, 160, {}, nested).defaultPrevented).toBe(
      false,
    );
  });

  it('explicit creation guard and the stable recognizer survive parent rerenders', () => {
    context.explicitToolActive = true;
    expect(dispatch('pointerdown').defaultPrevented).toBe(false);
    context.explicitToolActive = false;
    const recognizer = latest.recognizer;
    dispatch('pointerdown');
    act(() => root.render(<Harness />));
    expect(latest.recognizer).toBe(recognizer);
    dispatch('pointermove', 225, 225);
    expect(selected()).toEqual(['child']);
  });
  it('leaves a preselected Frame and ordinary child pointerdown/mousedown untouched', () => {
    mocks.nodes = mocks.nodes.map((n) => ({
      ...n,
      selected: n.id === 'frame',
    }));
    expect(dispatch('pointerdown').defaultPrevented).toBe(false);
    expect(captured).toBeNull();
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    frame.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    const child = document.createElement('div');
    child.className = 'react-flow__node';
    child.dataset.id = 'child';
    frame.append(child);
    expect(dispatch('pointerdown', 210, 210, {}, child).defaultPrevented).toBe(
      false,
    );
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each(['metaKey', 'ctrlKey'] as const)(
    'preserves %s click-to-toggle but rectangle drag still replaces like the pane',
    (key) => {
      dispatch('pointerdown', 150, 150, { [key]: true });
      dispatch('pointerup');
      expect(selected()).toEqual(['frame', 'old']);
      dispatch('pointerdown', 50, 50, { [key]: true }, pane);
      dispatch('pointermove', 225, 225);
      dispatch('pointerup', 225, 225);
      expect(selected()).toEqual(['child']);
    },
  );
  it('empty pane click clears selection without a drag, including Shift', () => {
    dispatch('pointerdown', 50, 50, { shiftKey: true }, pane);
    dispatch('pointerup', 50, 50);
    expect(selected()).toEqual([]);
    expect(flowState.nodesSelectionActive).toBe(false);
  });
  it.each(['touch', 'pen'])(
    'does not claim %s in any persisted input mode',
    (pointerType) => {
      for (const mode of ['mouse', 'pen', 'finger'] as const) {
        context.inputMode = mode;
        expect(
          dispatch('pointerdown', 150, 150, { pointerType }).defaultPrevented,
        ).toBe(false);
      }
      expect(getCanvasGesture()).toBeNull();
    },
  );
  it.each(['pen', 'finger'] as const)(
    'mouse still works in %s mode',
    (mode) => {
      context.inputMode = mode;
      dispatch('pointerdown');
      dispatch('pointerup');
      expect(selected()).toEqual(['frame']);
    },
  );
  it.each([
    'pan',
    'lasso',
    'sketch',
    'creation',
    'locked',
    'competing',
    'middle',
    'secondary',
  ])('does not claim %s input', (reason) => {
    if (['pan', 'lasso', 'sketch', 'creation'].includes(reason))
      act(() => root.render(<Harness enabled={false} />));
    if (reason === 'locked') context.interactivityLocked = true;
    if (reason === 'competing') mocks.available = false;
    const extra =
      reason === 'middle'
        ? { button: 1 }
        : reason === 'secondary'
          ? { isPrimary: false }
          : {};
    expect(dispatch('pointerdown', 150, 150, extra).defaultPrevented).toBe(
      false,
    );
    expect(selected()).toEqual(['old']);
    expect(captured).toBeNull();
  });
  it.each([
    'pointercancel',
    'lostpointercapture',
    'blur',
    'Escape',
    'disabled',
    'hidden',
    'buttons-lost',
  ])(
    'restores the original selection on %s, without a commit, and allows another gesture',
    (reason) => {
      dispatch('pointerdown');
      dispatch('pointermove', 225, 225);
      expect(selected()).toEqual(['child']);
      act(() => {
        if (reason === 'blur') window.dispatchEvent(new Event('blur'));
        else if (reason === 'Escape')
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
          );
        else if (reason === 'disabled')
          root.render(<Harness enabled={false} />);
        else if (reason === 'hidden') {
          vi.spyOn(document, 'hidden', 'get').mockReturnValueOnce(true);
          document.dispatchEvent(new Event('visibilitychange'));
        } else if (reason === 'buttons-lost')
          dispatch('pointermove', 230, 230, { buttons: 0 });
        else dispatch(reason);
      });
      expect(selected()).toEqual(['old']);
      expect(mocks.edges[0].selected).toBe(true);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(getCanvasGesture()).toBeNull();
      expect(captured).toBeNull();
      expect(flowState.userSelectionRect).toBeNull();
      act(() => root.render(<Harness />));
      dispatch('pointerdown');
      dispatch('pointerup');
      expect(selected()).toEqual(['frame']);
    },
  );
  it('pending cancellation has no selection side effect; unrelated lost capture cannot cancel the owner', () => {
    dispatch('pointerdown');
    dispatch('lostpointercapture', 0, 0, { pointerId: 2 });
    expect(captured).toBe(1);
    dispatch('pointercancel');
    expect(selected()).toEqual(['old']);
    expect(mocks.nodeChanges).not.toHaveBeenCalled();
  });
  it('unmount restores a live selection and releases capture', () => {
    dispatch('pointerdown');
    dispatch('pointermove', 225, 225);
    act(() => root.render(null));
    expect(selected()).toEqual(['old']);
    expect(captured).toBeNull();
    expect(getCanvasGesture()).toBeNull();
  });
  it('navigation does not restore old IDs into a different canvas', () => {
    dispatch('pointerdown');
    dispatch('pointermove', 225, 225);
    mocks.nodes = [
      { id: 'new', position: { x: 0, y: 0 }, selected: true, data: {} },
    ];
    act(() => root.render(<Harness scopeKey="new-canvas" />));
    expect(selected()).toEqual(['new']);
    expect(captured).toBeNull();
  });
  it('recomputes selection and screen paint when zoom changes under a stationary pointer', () => {
    dispatch('pointerdown', 50, 50, {}, pane);
    dispatch('pointermove', 400, 400);
    expect(selected()).toContain('frame');
    act(() => mocks.flow.setState({ transform: [0, 0, 2] }));
    expect(selected()).not.toContain('frame');
    expect(flowState.userSelectionRect).toMatchObject({
      x: 100,
      y: 100,
      width: 300,
      height: 300,
    });
  });
  it('auto-pans immediately at an edge, keeps the flow anchor, updates live hits, and emits no synthetic pointer events', () => {
    mocks.nodes = [
      {
        id: 'beyond',
        type: 'note',
        position: { x: 800, y: 200 },
        style: { width: 50, height: 50 },
        data: {},
      },
    ];
    const events = vi.fn();
    pane.addEventListener('pointermove', events);
    dispatch('pointerdown', 100, 100, {}, pane);
    dispatch('pointermove', 795, 250);
    expect(selected()).toEqual([]);
    tick();
    expect(flowState.transform[0]).toBeLessThan(0);
    expect(selected()).toEqual(['beyond']);
    expect(flowState.userSelectionRect?.startX).toBe(100);
    expect(events).not.toHaveBeenCalled();
    dispatch('pointerup', 795, 250);
    expect(rafs.size).toBe(0);
    expect(mocks.viewport).toHaveBeenLastCalledWith(instance.getViewport());
  });
});
