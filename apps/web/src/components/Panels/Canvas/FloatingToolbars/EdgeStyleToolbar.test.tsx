// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import { EdgeStyleToolbar } from './EdgeStyleToolbar';

import type { Edge, Node } from '@xyflow/react';

const state = vi.hoisted(() => ({
  mode: 'finger' as 'mouse' | 'finger' | 'pen',
  nodes: [] as Node[],
  edges: [] as Edge[],
  disconnectEdges: vi.fn(),
  executeCommands: vi.fn(),
}));
vi.mock('@/store/canvasStore', () => ({
  default: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('@/hooks/useInputMode', () => ({
  useEffectiveInputMode: () => state.mode,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/Common/CanvasFloatingPopover', () => ({
  CanvasFloatingPopover: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.mode = 'finger';
  state.nodes = ['a', 'b', 'c'].map((id, index) => ({
    id,
    type: 'note',
    position: { x: index * 300, y: 0 },
    data: {},
  }));
  state.edges = [
    { id: 'ab', source: 'a', target: 'b', selected: true },
    { id: 'bc', source: 'b', target: 'c', selected: true },
  ];
  useGesturePreviewStore.getState().clearSketchStrokeSelection();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () => act(() => root.render(<EdgeStyleToolbar />));

it.each(['finger', 'pen'] as const)(
  'deletes all selected edges directly in %s mode',
  (mode) => {
    state.mode = mode;
    render();
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="toolbar.deleteSelected"]',
    );
    expect(button).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    act(() => button?.click());
    expect(state.disconnectEdges).toHaveBeenCalledExactlyOnceWith(['ab', 'bc']);
  },
);

it('retains single-edge styles and deletes only that edge', () => {
  state.edges[1].selected = false;
  render();
  expect(
    container.querySelector('[aria-label="edgeToolbar.type"]'),
  ).not.toBeNull();
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="edgeToolbar.deleteEdge"]')
      ?.click(),
  );
  expect(state.disconnectEdges).toHaveBeenCalledExactlyOnceWith(['ab']);
});

it('retains mouse styles without adding a primary Delete', () => {
  state.mode = 'mouse';
  render();
  expect(container.childElementCount).toBe(0);
  state.edges = state.edges.map((edge, index) => ({
    ...edge,
    selected: index === 0,
  }));
  render();
  expect(
    container.querySelector('[aria-label="edgeToolbar.type"]'),
  ).not.toBeNull();
  expect(container.querySelector('.lucide-trash-2')).toBeNull();
});

it.each(['nodes', 'lasso', 'empty'])(
  'does not add an edge toolbar for %s selection',
  (kind) => {
    if (kind === 'nodes') state.nodes[0].selected = true;
    if (kind === 'lasso')
      useGesturePreviewStore.setState({
        sketchStrokeSelection: { ink: ['stroke'] },
      });
    if (kind === 'empty') state.edges = [];
    render();
    expect(container.childElementCount).toBe(0);
  },
);
