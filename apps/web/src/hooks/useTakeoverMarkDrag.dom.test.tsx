// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTakeoverMarkDrag } from './useTakeoverMarkDrag';

import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  nodes: [] as Node[],
  mode: 'pen',
  zoom: 1,
  nodesConnectable: true,
  available: true,
  start: vi.fn(),
  move: vi.fn(),
  changes: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  active: vi.fn(),
}));
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: x / mocks.zoom,
      y: y / mocks.zoom,
    }),
  }),
  useStoreApi: () => ({ getState: () => mocks }),
}));
vi.mock('@/hooks/useInputMode', () => ({
  readEffectiveInputMode: () => mocks.mode,
}));
vi.mock('@/handler/canvasInteractionOwner', () => ({
  canTouchClaimViewport: () => mocks.available,
}));
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({
      nodes: mocks.nodes,
      onNodeDragStart: mocks.start,
      onNodeDrag: mocks.move,
      onNodesChange: mocks.changes,
      onNodeDragStop: mocks.stop,
      cancelActiveNodeDrag: mocks.cancel,
    }),
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let grip: HTMLDivElement;
let captured: number | null;

function Surface({
  enabled = true,
  sole = true,
}: {
  enabled?: boolean;
  sole?: boolean;
}) {
  const drag = useTakeoverMarkDrag('node', {
    enabled,
    soleSelectionOnly: sole,
    onActiveChange: mocks.active,
  });
  return <div role="img" aria-label="Drag" tabIndex={-1} {...drag} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodes = [
    { id: 'node', position: { x: 10, y: 20 }, selected: true, data: {} },
  ];
  mocks.mode = 'pen';
  mocks.zoom = 1;
  mocks.nodesConnectable = true;
  mocks.available = true;
  captured = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Surface />));
  grip = container.firstElementChild as HTMLDivElement;
  grip.setPointerCapture = vi.fn((id) => {
    captured = id;
  });
  grip.hasPointerCapture = vi.fn((id) => captured === id);
  grip.releasePointerCapture = vi.fn(() => {
    captured = null;
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pointer(type: string, x = 0, y = 0, extra: PointerEventInit = {}) {
  act(() =>
    grip.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
        ...extra,
      }),
    ),
  );
}

describe('shared portal drag lifecycle', () => {
  it.each([
    ['mouse', 1],
    ['pen', 4],
    ['touch', 8],
  ] as const)(
    'uses the canonical %s activation gate',
    (pointerType, distance) => {
      pointer('pointerdown', 0, 0, { pointerType });
      expect(document.activeElement).toBe(grip);
      expect(mocks.active).toHaveBeenLastCalledWith(true);
      pointer('pointermove', distance - 0.1, 0, { pointerType });
      expect(mocks.start).not.toHaveBeenCalled();
      pointer('pointermove', distance, 0, { pointerType });
      pointer('pointermove', distance + 2, 0, { pointerType });
      expect(mocks.start).toHaveBeenCalledOnce();
      pointer('pointerup', distance + 2, 0, { pointerType });
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.active).toHaveBeenLastCalledWith(false);
      expect(captured).toBeNull();
      expect(mocks.cancel).not.toHaveBeenCalled();
    },
  );

  it.each([0.5, 1, 2])(
    'projects live and final node positions through the store at zoom %s',
    (zoom) => {
      mocks.zoom = zoom;
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 120, 110, {
        altKey: true,
        ctrlKey: true,
        metaKey: true,
      });
      expect(mocks.changes).toHaveBeenLastCalledWith([
        {
          id: 'node',
          type: 'position',
          position: { x: 10 + 20 / zoom, y: 20 + 10 / zoom },
          dragging: true,
        },
      ]);
      expect(mocks.move).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clientX: 120,
          clientY: 110,
          altKey: true,
          ctrlKey: true,
          metaKey: true,
        }),
        expect.objectContaining({
          position: { x: 10 + 20 / zoom, y: 20 + 10 / zoom },
        }),
        expect.any(Array),
      );
      pointer('pointerup', 120, 110);
      expect(mocks.changes.mock.lastCall?.[0][0].dragging).toBe(false);
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      act(() => grip.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
    },
  );

  it('treats a pending release as a click without history or geometry changes', () => {
    pointer('pointerdown');
    pointer('pointerup');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.changes).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(captured).toBeNull();
  });

  it.each([
    'pointercancel',
    'lostpointercapture',
    'blur',
    'Escape',
    'disabled',
    'unmount',
  ])('cancels on %s and releases ownership without a drop', (reason) => {
    pointer('pointerdown');
    pointer('pointermove', 20, 10);
    act(() => {
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'Escape')
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      else if (reason === 'disabled') root.render(<Surface enabled={false} />);
      else if (reason === 'unmount') root.render(null);
      else pointer(reason);
    });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(captured).toBeNull();
    expect(mocks.active).toHaveBeenLastCalledWith(false);
    pointer('pointerup', 20, 10);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it.each([
    'locked',
    'canvas-lock',
    'multi',
    'unselected',
    'other-owner',
    'mouse-mode-touch',
    'finger-mode-pen',
    'disabled',
  ])('rejects %s before capturing a pointer', (reason) => {
    if (reason === 'locked') mocks.nodes[0].data.locked = true;
    if (reason === 'canvas-lock') mocks.nodesConnectable = false;
    if (reason === 'multi')
      mocks.nodes.push({
        id: 'peer',
        selected: true,
        position: { x: 100, y: 20 },
        data: {},
      });
    if (reason === 'unselected') mocks.nodes[0].selected = false;
    if (reason === 'other-owner') mocks.available = false;
    if (reason === 'mouse-mode-touch') mocks.mode = 'mouse';
    if (reason === 'finger-mode-pen') mocks.mode = 'finger';
    if (reason === 'disabled')
      act(() => root.render(<Surface enabled={false} />));
    pointer('pointerdown', 0, 0, {
      pointerType:
        reason === 'mouse-mode-touch'
          ? 'touch'
          : reason === 'finger-mode-pen'
            ? 'pen'
            : 'mouse',
    });
    pointer('pointermove', 30, 20);
    expect(captured).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('ignores a second pointer and cancels if the canvas locks mid-gesture', () => {
    pointer('pointerdown');
    pointer('pointermove', 10, 0);
    pointer('pointerdown', 30, 30, { pointerId: 2 });
    pointer('pointerup', 50, 50, { pointerId: 2 });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(captured).toBe(1);
    mocks.nodesConnectable = false;
    pointer('pointermove', 20, 0);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(captured).toBeNull();
  });

  it('retains takeover-mark multi-selection behavior while omitting locked peers', () => {
    mocks.nodes.push(
      { id: 'peer', selected: true, position: { x: 100, y: 20 }, data: {} },
      {
        id: 'locked',
        selected: true,
        position: { x: 200, y: 20 },
        data: { locked: true },
      },
    );
    act(() => root.render(<Surface sole={false} />));
    pointer('pointerdown');
    pointer('pointermove', 10, 0);
    expect(
      mocks.changes.mock.lastCall?.[0].map(
        (change: { id: string }) => change.id,
      ),
    ).toEqual(['node', 'peer']);
  });
});
