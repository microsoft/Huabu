import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { usePreviewStore } from '@/store/previewStore';

import { ExpandedNodePanel } from './ExpandedNodePanel';

import type { EdgeDirection } from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const testStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
});

vi.mock('../../Nodes/NodePreviewContent.tsx', () => ({
  NodePreviewContent: ({ id }: { id?: string }) => (
    <div data-preview-node-id={id} />
  ),
}));

vi.mock('./InPreviewSearchBar.tsx', () => ({
  InPreviewSearchBar: () => null,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

function canvasNode(id: string, label: string): Node {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: { label },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  direction: EdgeDirection = 'forward',
): Edge {
  return {
    id,
    source,
    target,
    data: { edgeStyle: { direction } },
  };
}

function renderPanel(nodes: Node[], edges: Edge[], mode: 'replace' | 'split') {
  useCanvasStore.setState({
    nodes,
    edges,
    expandedNodeId: 'a',
    expandMode: mode,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ExpandedNodePanel />));
}

function dispatchArrow(target: EventTarget, key: 'ArrowLeft' | 'ArrowRight') {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  testStorage.clear();
  usePreviewStore.setState({ previewType: null, previewData: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove());
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    expandedNodeId: null,
    expandMode: 'split',
  });
  root = null;
  container = null;
});

describe('ExpandedNodePanel edge navigation', () => {
  it('groups available relationships behind one menu', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
      'split',
    );

    const navigationButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    expect(navigationButton).not.toBeNull();

    act(() => navigationButton?.click());

    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      'Destinations',
    );
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(
      'Sources',
    );
  });

  it('navigates an edge without arrows through the neutral control', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b', 'none')],
      'split',
    );

    const navigationButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    expect(navigationButton).not.toBeNull();

    act(() => navigationButton?.click());
    const connectedItem =
      document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    act(() => connectedItem?.click());

    expect(useCanvasStore.getState().expandedNodeId).toBe('b');
  });

  it('opens a sole downstream neighbor and preserves replace mode', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
      'replace',
    );

    dispatchArrow(window, 'ArrowRight');

    expect(useCanvasStore.getState().expandedNodeId).toBe('b');
    expect(useCanvasStore.getState().expandMode).toBe('replace');
    expect(
      useCanvasStore
        .getState()
        .nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(['b']);
  });

  it('releases the relationship menu so arrow navigation can continue', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
      'split',
    );
    const navigationButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    expect(navigationButton).not.toBeNull();

    act(() => {
      navigationButton?.focus();
      navigationButton?.click();
    });
    const downstreamItem =
      document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    act(() => downstreamItem?.click());

    expect(useCanvasStore.getState().expandedNodeId).toBe('b');
    expect(document.activeElement).not.toBe(navigationButton);

    dispatchArrow(document.body, 'ArrowLeft');
    expect(useCanvasStore.getState().expandedNodeId).toBe('a');
  });

  it('opens a stable chooser for multiple neighbors and selects one', () => {
    renderPanel(
      [
        canvasNode('a', 'Alpha'),
        canvasNode('c', 'Gamma'),
        canvasNode('b', 'Beta'),
      ],
      [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c')],
      'split',
    );

    dispatchArrow(window, 'ArrowRight');

    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    expect(items.map((item) => item.textContent)).toEqual(['Gamma', 'Beta']);
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      items[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);

    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(useCanvasStore.getState().expandedNodeId).toBe('b');
    expect(useCanvasStore.getState().expandMode).toBe('split');
    expect(
      useCanvasStore
        .getState()
        .nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(['b']);
    expect(document.activeElement).toBe(
      container?.querySelector('[data-search-scope="node"]'),
    );
  });

  it('restores trigger focus when Escape dismisses the chooser', () => {
    renderPanel(
      [
        canvasNode('a', 'Alpha'),
        canvasNode('b', 'Beta'),
        canvasNode('c', 'Gamma'),
      ],
      [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c')],
      'split',
    );
    const navigationButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );

    dispatchArrow(window, 'ArrowRight');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(navigationButton);
  });

  it('does not capture arrow keys from editable controls', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('b-a', 'b', 'a')],
      'split',
    );
    const input = document.createElement('input');
    document.body.appendChild(input);

    dispatchArrow(input, 'ArrowLeft');

    expect(useCanvasStore.getState().expandedNodeId).toBe('a');
    input.remove();
  });
});
