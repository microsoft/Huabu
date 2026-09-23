// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Position } from '@xyflow/react';
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConnectPortStore } from '@/store/connectPortStore';
import {
  blendedMarkRect,
  useNodeCollapseStore,
} from '@/store/nodeCollapseStore';

import {
  connectionPortOffset,
  NodeConnectionHandles,
  scheduleHandleRefresh,
  shouldExposeConnectionPorts,
  SIDE_POSITION,
} from './NodeConnectAffordance';

import type * as ReactFlow from '@xyflow/react';
import type * as ReactI18next from 'react-i18next';

const mocks = vi.hoisted(() => ({
  flow: { domNode: null as HTMLElement | null, transform: [10, 20, 0.5] },
  node: {
    type: 'note',
    measured: { width: 400, height: 200 },
    style: { width: 400, height: 200 },
    internals: { positionAbsolute: { x: 100, y: 200 } },
  },
  connection: {
    inProgress: false,
    fromHandle: null as { nodeId: string; id: string } | null,
  },
  updateNodeInternals: vi.fn(),
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactFlow>()),
  useStore: (select: (state: typeof mocks.flow) => unknown) =>
    select(mocks.flow),
  useInternalNode: () => mocks.node,
  useStoreApi: () => mocks.flow,
  useConnection: (select: (state: typeof mocks.connection) => unknown) =>
    select(mocks.connection),
  useUpdateNodeInternals: () => mocks.updateNodeInternals,
  Handle: ({
    id,
    type,
    position,
    isConnectable,
    isConnectableStart,
    isConnectableEnd,
    children,
    ...props
  }: {
    id: string;
    type: string;
    position: string;
    isConnectable: boolean;
    isConnectableStart: boolean;
    isConnectableEnd: boolean;
    children: ReactNode;
  }) =>
    createElement(
      'div',
      {
        ...props,
        'data-handleid': id,
        'data-type': type,
        'data-position': position,
        'data-connectable': isConnectable,
        'data-connectable-start': isConnectableStart,
        'data-connectable-end': isConnectableEnd,
      },
      children,
    ),
}));
vi.mock('@/hooks/useMultiSelectModifier.ts', () => ({
  useMultiSelectModifierHeld: () => false,
}));
vi.mock('@/components/Common/Tooltip.tsx', () => ({
  Tooltip: ({ children }: { children: ReactNode }) =>
    createElement('span', null, children),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('scheduleHandleRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('deduplicates a large commit into one update per flow instance', async () => {
    const scope = {};
    const update = vi.fn();
    for (let index = 0; index < 665; index++) {
      scheduleHandleRefresh(scope, `node-${index}`, update);
      scheduleHandleRefresh(scope, `node-${index}`, update);
    }
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toHaveLength(665);
    scheduleHandleRefresh(scope, 'node-next', update);
    await vi.advanceTimersByTimeAsync(20);
    expect(update).toHaveBeenLastCalledWith(['node-next']);
  });

  it('isolates canvases and cancels only the matching pending request', async () => {
    const scope = {};
    const update = vi.fn();
    const otherUpdate = vi.fn();
    const cancelOld = scheduleHandleRefresh(scope, 'node', update);
    scheduleHandleRefresh(scope, 'node', update);
    cancelOld();
    const cancelRemoved = scheduleHandleRefresh(scope, 'removed', update);
    cancelRemoved();
    scheduleHandleRefresh({}, 'node', otherUpdate);
    await vi.advanceTimersByTimeAsync(20);
    expect(update).toHaveBeenCalledExactlyOnceWith(['node']);
    expect(otherUpdate).toHaveBeenCalledExactlyOnceWith(['node']);
  });

  it('does not update an unmounted batch', async () => {
    const update = vi.fn();
    const cancel = scheduleHandleRefresh({}, 'node', update);
    cancel();
    await vi.advanceTimersByTimeAsync(20);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('connectionPortOffset', () => {
  it.each([0.05, 0.25, 1, 2, 5])(
    'keeps all four port centres 16 screen px outward at zoom %s',
    (zoom) => {
      for (const [position, x, y] of [
        [Position.Top, 0, -16],
        [Position.Right, 16, 0],
        [Position.Bottom, 0, 16],
        [Position.Left, -16, 0],
      ] as const) {
        const offset = connectionPortOffset(position, zoom);
        expect(offset.x * zoom).toBeCloseTo(x);
        expect(offset.y * zoom).toBeCloseTo(y);
      }
    },
  );

  it.each([0, -1])('uses a finite fallback for invalid zoom %s', (zoom) => {
    expect(connectionPortOffset(Position.Top, zoom)).toEqual({ x: 0, y: -16 });
  });

  it.each([
    [20, 8],
    [28, 14],
  ])(
    'spends the extra %s px hit area outward from the %s px dot',
    (hitSize, dotSize) => {
      const zoom = 0.25;
      const padding = (hitSize - dotSize) / 2;
      const hit = connectionPortOffset(Position.Right, zoom, 16 + padding);
      const circle = connectionPortOffset(Position.Right, zoom, -padding);
      expect((hit.x + circle.x) * zoom).toBe(16);
      expect(hit.x * zoom - hitSize / 2).toBe(16 - dotSize / 2);
    },
  );
});

describe('shouldExposeConnectionPorts', () => {
  it('exposes ports only for an idle sole selection', () => {
    expect(
      shouldExposeConnectionPorts({
        selected: true,
        connecting: false,
        hovered: false,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(true);
  });

  it('exposes target ports only while hovering a node during a connection drag', () => {
    expect(
      shouldExposeConnectionPorts({
        selected: false,
        connecting: true,
        hovered: true,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(true);

    expect(
      shouldExposeConnectionPorts({
        selected: false,
        connecting: true,
        hovered: false,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(false);
  });

  it.each([false, true])(
    'suppresses resizing even when connecting is %s',
    (connecting) => {
      expect(
        shouldExposeConnectionPorts({
          selected: true,
          connecting,
          hovered: true,
          dragging: false,
          resizing: true,
          multiSelectModifierHeld: false,
        }),
      ).toBe(false);
      expect(
        shouldExposeConnectionPorts({
          selected: false,
          connecting,
          hovered: true,
          dragging: false,
          resizing: true,
          multiSelectModifierHeld: false,
        }),
      ).toBe(false);
    },
  );

  it.each([
    {
      selected: false,
      connecting: false,
      hovered: false,
      dragging: false,
      multiSelectModifierHeld: false,
    },
    {
      selected: true,
      connecting: false,
      hovered: false,
      dragging: true,
      multiSelectModifierHeld: false,
    },
    {
      selected: true,
      connecting: false,
      hovered: false,
      dragging: false,
      multiSelectModifierHeld: true,
    },
  ])('keeps ports hidden for %o', (state) => {
    expect(shouldExposeConnectionPorts(state)).toBe(false);
  });
});

describe('NodeConnectionHandles contract', () => {
  let container: HTMLDivElement;
  let hud: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'react-flow__node';
    container.dataset.id = 'node';
    hud = document.createElement('div');
    document.body.append(container, hud);
    root = createRoot(container);
    mocks.flow.domNode = hud;
    mocks.flow.transform = [10, 20, 0.5];
    mocks.node.type = 'note';
    mocks.connection.inProgress = false;
    mocks.connection.fromHandle = null;
    mocks.updateNodeInternals.mockClear();
    useConnectPortStore.getState().setPending(null);
    useNodeCollapseStore.getState().setMark('node', null);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    hud.remove();
    useConnectPortStore.getState().setPending(null);
    useNodeCollapseStore.getState().setMark('node', null);
  });
  function render(
    props: Partial<ComponentProps<typeof NodeConnectionHandles>> = {},
  ) {
    act(() =>
      root.render(
        createElement(NodeConnectionHandles, {
          nodeId: 'node',
          hovered: false,
          selected: true,
          isNotMouse: false,
          dragging: false,
          ...props,
        }),
      ),
    );
  }
  function handle(side: string) {
    const element = container.querySelector<HTMLElement>(
      `[data-handleid="${side}-source"]`,
    );
    if (!element) throw new Error(`Missing ${side} handle`);
    return element;
  }
  function hit(side: string) {
    const element = handle(side).querySelector<HTMLElement>('span[tabindex]');
    if (!element) throw new Error(`Missing ${side} hit target`);
    return element;
  }
  function translation(element: HTMLElement) {
    const match = element.style.transform.match(
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/,
    );
    if (!match) throw new Error('Missing pixel translation');
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  it.each(
    [0.5, 1, 2].flatMap((zoom) =>
      ['note', 'pdf', 'web', 'text', 'image', 'video', 'sketch', 'frame'].map(
        (type) => ({ type, zoom }),
      ),
    ),
  )(
    'keeps $type edge bounds on the real border at $zoom zoom while all four dots move outward',
    ({ type, zoom }) => {
      mocks.node.type = type;
      mocks.flow.transform = [10, 20, zoom];
      render();
      expect(container.querySelectorAll('[data-handleid]')).toHaveLength(8);
      expect(container.querySelectorAll('[role="button"]')).toHaveLength(4);
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const anchor = handle(side);
        const inset = ['note', 'pdf', 'web', 'text'].includes(type)
          ? '-3px'
          : '0px';
        expect(anchor.style[side]).toBe(inset);
        expect(
          anchor.style[
            side === 'top' || side === 'bottom' ? 'height' : 'width'
          ],
        ).toBe('0px');
        const target = hit(side);
        const dot = hud.querySelector<HTMLElement>(
          `[data-connection-port-dot="node:${side}"]`,
        );
        if (!dot) throw new Error(`Missing ${side} HUD dot`);
        const offset = translation(target);
        const position = SIDE_POSITION[side];
        expect(offset).toEqual(connectionPortOffset(position, zoom, 16));
        const boundary = {
          x: (side === 'left' ? 100 : side === 'right' ? 500 : 300) * zoom + 10,
          y: (side === 'top' ? 200 : side === 'bottom' ? 400 : 300) * zoom + 20,
        };
        expect({
          x: parseFloat(dot.style.left) + 4 - boundary.x,
          y: parseFloat(dot.style.top) + 4 - boundary.y,
        }).toEqual(connectionPortOffset(position, 1));
        expect(target.children).toHaveLength(0);
        expect(dot.parentElement).toBe(hud);
        expect(dot.classList.contains('z-999')).toBe(true);
        expect(dot.classList.contains('pointer-events-none')).toBe(true);
        expect(dot.style.backgroundColor).toBe('var(--color-info-light)');
        expect(
          target.closest('.react-flow__node')?.getAttribute('data-id'),
        ).toBe('node');
        expect(anchor.dataset.connectableStart).toBe('true');
        expect(anchor.dataset.connectableEnd).toBe('true');
      }
    },
  );

  it('hides idle paint with disclosure and preserves touch opacity and target feedback', () => {
    render({ selected: false });
    expect(hud.children).toHaveLength(0);
    mocks.connection.inProgress = true;
    render({ selected: false, hovered: true, isNotMouse: true });
    expect(hud.querySelectorAll('[data-connection-port-dot]')).toHaveLength(4);
    for (const dot of hud.querySelectorAll<HTMLElement>(
      '[data-connection-port-dot]',
    )) {
      expect(dot.style.opacity).toBe('1');
      expect(dot.style.boxShadow).toContain('var(--color-info-light)');
    }
    render({ selected: false, hovered: false });
    expect(hud.children).toHaveLength(0);
    mocks.connection.inProgress = false;
    render({ dragging: true });
    expect(hud.children).toHaveLength(0);
  });

  it.each([0.5, 0.1, 2])(
    'does not measure hidden ports or refresh their internals during navigation at %s zoom',
    async (zoom) => {
      const query = vi.spyOn(hud, 'querySelectorAll');
      render({ selected: false });
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      mocks.updateNodeInternals.mockClear();
      mocks.flow.transform = [210, 320, zoom];
      render({ selected: false, hovered: true });
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(query).not.toHaveBeenCalled();
      expect(mocks.updateNodeInternals).not.toHaveBeenCalled();
      expect(container.querySelectorAll('[data-handleid]')).toHaveLength(8);
      query.mockRestore();
      render({ selected: true });
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(mocks.updateNodeInternals).toHaveBeenCalledWith(['node']);
      expect(translation(hit('top'))).toEqual(
        connectionPortOffset(Position.Top, zoom, 16),
      );
    },
  );

  it.each(['pdf', 'web'])(
    'tracks the rendered %s border through reading-mode changes',
    async (type) => {
      mocks.node.type = type;
      mocks.flow.transform = [10, 20, 2];
      act(() => root.unmount());
      const surface = document.createElement('div');
      surface.dataset.nodeSurface = '';
      surface.style.border = '3px solid transparent';
      surface.style.borderRadius = '12px';
      container.append(surface);
      hud.append(container);
      root = createRoot(surface);
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(210, 420, 800, 400),
      );
      Object.defineProperty(surface, 'offsetWidth', { value: 400 });
      render();
      expect(handle('top').style.top).toBe('-3px');
      for (const border of [0, 3]) {
        await act(async () => {
          surface.style.borderWidth = `${border}px`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(handle('top').style.top).toBe(`${-border}px`);
        expect(handle('top').style.left).toBe(`${200 - border}px`);
        expect(handle('right').style.left).toBe(`${400 - border}px`);
        expect(handle('bottom').style.top).toBe(`${200 - border}px`);
        const dot = hud.querySelector<HTMLElement>(
          '[data-connection-port-dot="node:top"]',
        );
        expect(dot?.style.left).toBe('606px');
        expect(dot?.style.top).toBe('400px');
      }
      act(() =>
        hit('top').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      expect(useConnectPortStore.getState().pending?.anchor).toEqual({
        x: 300,
        y: 200,
      });
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(mocks.updateNodeInternals).toHaveBeenCalled();
    },
  );

  it('paints only the pinned port when ordinary disclosure is closed', () => {
    useConnectPortStore.getState().setPending({
      sourceId: 'node',
      side: 'right',
      anchor: { x: 500, y: 300 },
      kind: 'side',
    });
    render({ selected: false });
    expect(hud.children).toHaveLength(1);
    expect(
      hud.querySelector('[data-connection-port-icon="node:right"]'),
    ).not.toBeNull();
  });

  it.each(['Enter', ' '])(
    'retains side-aligned keyboard creation with %s',
    (key) => {
      render();
      act(() =>
        hit('right').dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        ),
      );
      expect(useConnectPortStore.getState().pending).toEqual({
        sourceId: 'node',
        side: 'right',
        anchor: { x: 500, y: 300 },
        kind: 'side',
      });
    },
  );

  it('retains hover Plus paint without moving the handle bbox', () => {
    render();
    const anchor = handle('right');
    const before = anchor.style.cssText;
    act(() =>
      hit('right').dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true }),
      ),
    );
    expect(hud.querySelector('svg')).not.toBeNull();
    const overlay = hud.querySelector<HTMLElement>(
      '[data-connection-port-icon="node:right"]',
    );
    if (!overlay) throw new Error('Missing hot HUD port');
    expect(hud.querySelectorAll('[data-connection-port-dot]')).toHaveLength(3);
    expect(hud.children).toHaveLength(4);
    expect(overlay.style.left).toBe('266px');
    expect(overlay.style.top).toBe('160px');
    expect(hit('right').children).toHaveLength(0);
    expect(anchor.style.cssText).toBe(before);
  });

  it.each(['pinned', 'connecting', 'focused'])(
    'hides and disables %s ports during resize but retains all handle elements',
    (state) => {
      if (state === 'pinned')
        useConnectPortStore.getState().setPending({
          sourceId: 'node',
          side: 'right',
          anchor: { x: 500, y: 300 },
          kind: 'side',
        });
      if (state === 'connecting') {
        mocks.connection.inProgress = true;
        mocks.connection.fromHandle = { nodeId: 'node', id: 'right-source' };
      }
      render();
      if (state === 'focused') act(() => hit('right').focus());
      const handles = [
        ...container.querySelectorAll<HTMLElement>('[data-handleid]'),
      ];
      render({ resizing: true });
      expect([...container.querySelectorAll('[data-handleid]')]).toEqual(
        handles,
      );
      expect(hud.children).toHaveLength(0);
      expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
      for (const anchor of handles) {
        expect(anchor.style.opacity).toBe('0');
        expect(anchor.style.pointerEvents).toBe('none');
        expect(anchor.dataset.connectable).toBe('false');
        expect(anchor.dataset.connectableStart).toBe('false');
        expect(anchor.dataset.connectableEnd).toBe('false');
        expect(anchor.querySelector('span[tabindex]')?.className).toContain(
          'pointer-events-none',
        );
      }
      act(() => useConnectPortStore.getState().setPending(null));
      act(() =>
        hit('right').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      expect(useConnectPortStore.getState().pending).toBeNull();
      render({ resizing: false });
      expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(4);
      expect(handle('right').dataset.connectableStart).toBe('true');
    },
  );

  it.each([0.2, 0.5, 2])(
    'shares the published mark boundary for collapsed hit and paint at zoom %s',
    (zoom) => {
      mocks.flow.transform = [10, 20, zoom];
      const mark = {
        cx: 300,
        cy: 300,
        radius: 150,
        progress: 0.75,
        footprint: { x: 100, y: 200, width: 400, height: 200 },
      };
      useNodeCollapseStore.getState().setMark('node', mark);
      render();
      const rect = blendedMarkRect(mark);
      const borderX = rect.x + rect.width;
      const borderY = rect.y + rect.height / 2;
      const dot = hud.children[1] as HTMLElement;
      const dotCenter = {
        x: parseFloat(dot.style.left) + 4,
        y: parseFloat(dot.style.top) + 4,
      };
      expect(dotCenter).toEqual({
        x: borderX * zoom + 10 + 16,
        y: borderY * zoom + 20,
      });
      expect(parseFloat(handle('right').style.left) + 3).toBe(borderX - 100);
      act(() => hit('right').focus());
      const overlay = hud.querySelector('svg')?.parentElement;
      if (!overlay) throw new Error('Missing hot port overlay');
      expect({
        x: parseFloat(overlay.style.left) + 10,
        y: parseFloat(overlay.style.top) + 10,
      }).toEqual(dotCenter);
      expect(hud.children).toHaveLength(4);
      render({ resizing: true });
      expect(hud.children).toHaveLength(0);
      expect(container.querySelectorAll('[data-handleid]')).toHaveLength(8);
    },
  );
});
