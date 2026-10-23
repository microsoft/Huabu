// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useFrameDragToCreate } from './useFrameDragToCreate';

import type { ReactFlowInstance } from '@xyflow/react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const create = vi.fn();
const click = vi.fn();
const end = vi.fn();
let host: HTMLDivElement;
let root: Root;
let zoom = 1;

function Harness({
  active = true,
  child = true,
  scopeKey = 'child',
}: {
  active?: boolean;
  child?: boolean;
  scopeKey?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rfInstanceRef = useRef({
    screenToFlowPosition: (point: { x: number; y: number }) => ({
      x: point.x / zoom,
      y: point.y / zoom,
    }),
  } as ReactFlowInstance);
  const { pointerHandlers } = useFrameDragToCreate({
    active,
    scopeKey,
    wrapperRef,
    rfInstanceRef,
    onCreate: create,
    onClick: child ? click : undefined,
    onEnd: end,
  });
  return (
    <div ref={wrapperRef} {...pointerHandlers}>
      <div className="react-flow__pane" />
      <div className="react-flow__node" />
    </div>
  );
}

function pointer(
  type: string,
  x: number,
  y: number,
  pointerType = 'mouse',
  selector = '.react-flow__pane',
) {
  act(() =>
    host.querySelector(selector)?.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  zoom = 1;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
  const wrapper = host.firstElementChild;
  if (!wrapper) throw new Error('Missing gesture surface');
  Object.assign(wrapper, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it.each(['mouse', 'touch', 'pen'])(
  'creates on an empty-canvas %s tap and preserves Frame tap behavior',
  (pointerType) => {
    pointer('pointerdown', 50, 60, pointerType);
    pointer('pointerup', 50, 60, pointerType);
    expect(click).toHaveBeenCalledWith({ x: 50, y: 60 });
    expect(create).not.toHaveBeenCalled();
    act(() => root.render(<Harness child={false} />));
    pointer('pointerdown', 50, 60, pointerType);
    pointer('pointerup', 50, 60, pointerType);
    expect(click).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  },
);

it('commits a rectangle rather than a click and normalizes reverse drags', () => {
  pointer('pointerdown', 200, 180);
  pointer('pointermove', 50, 60);
  pointer('pointerup', 50, 60);
  expect(create).toHaveBeenCalledWith({
    x: 50,
    y: 60,
    width: 150,
    height: 120,
  });

  expect(click).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledOnce();
});

it('treats a small touch movement as a tap even at 10% zoom', () => {
  zoom = 0.1;
  pointer('pointerdown', 50, 60, 'touch');
  pointer('pointerup', 53, 63, 'touch');
  expect(click).toHaveBeenCalledWith({ x: 530, y: 630 });
  expect(create).not.toHaveBeenCalled();
  act(() => root.render(<Harness child={false} />));
  pointer('pointerdown', 50, 60, 'touch');
  pointer('pointerup', 53, 63, 'touch');
  expect(create).toHaveBeenCalledWith({
    x: 500,
    y: 600,
    width: 30,
    height: 30,
  });
});

it.each(['escape', 'cancel', 'tool-switch', 'frame-switch'])(
  'does not create after %s',
  (action) => {
    pointer('pointerdown', 50, 60);
    pointer('pointermove', 200, 180);
    if (action === 'escape')
      act(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      );
    if (action === 'cancel') pointer('pointercancel', 200, 180);
    if (action === 'tool-switch')
      act(() => root.render(<Harness active={false} />));
    if (action === 'frame-switch')
      act(() => root.render(<Harness scopeKey="frame" child={false} />));
    pointer('pointerup', 200, 180);
    expect(create).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  },
);

it('does not interpret a node click or a narrow drag as empty-space creation', () => {
  pointer('pointerdown', 50, 60, 'mouse', '.react-flow__node');
  pointer('pointerup', 50, 60);
  pointer('pointerdown', 50, 60);
  pointer('pointerup', 200, 65);
  expect(create).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});
