// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';

import { ExpandedNodePanel } from './ExpandedNodePanel';

import type { EdgeDirection } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS_ID = 'test-canvas';

/** The node the workspace is showing; presentation moved off `canvasStore`. */
const expandedNodeId = () =>
  selectActiveNodeId(usePreviewWorkspaceStore.getState());

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
  NodePreviewContent: ({
    id,
    onDataChange,
  }: {
    id?: string;
    onDataChange?: (patch: Record<string, unknown>) => void;
  }) => (
    <div data-preview-node-id={id}>
      <button
        type="button"
        data-testid="mutate-node"
        onClick={() => onDataChange?.({ content: 'Updated' })}
      />
    </div>
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

function renderPanel(
  nodes: Node[],
  edges: Edge[],
  embedded = false,
  onCommit?: () => void,
) {
  useCanvasStore.setState({
    nodes,
    edges,
    canvasId: CANVAS_ID,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace(),
  });
  usePreviewWorkspaceStore
    .getState()
    .openPreviewTarget({ kind: 'node', canvasId: CANVAS_ID, nodeId: 'a' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(<ExpandedNodePanel embedded={embedded} onCommit={onCommit} />),
  );
}

function dispatchArrow(target: EventTarget, key: 'ArrowLeft' | 'ArrowRight') {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function previewBody() {
  const body = container?.querySelector(
    '[data-preview-node-id]',
  )?.parentElement;
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function touchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend',
  points: Array<{ id: number; x: number; y?: number }>,
  changed = points,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const toTouch = (p: { id: number; x: number; y?: number }) => ({
    identifier: p.id,
    clientX: p.x,
    clientY: p.y ?? 0,
  });
  Object.defineProperty(event, 'touches', { value: points.map(toTouch) });
  Object.defineProperty(event, 'changedTouches', {
    value: changed.map(toTouch),
  });
  return event;
}

/** Walks the finger across `to` in steps so the axis lock can engage. */
function swipe(from: number, to: number, y = 0, target?: HTMLElement) {
  const origin = target ?? previewBody();
  act(() => {
    origin.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: from }]));
    const midpoint = from + (to - from) / 2;
    origin.dispatchEvent(
      touchEvent('touchmove', [{ id: 1, x: midpoint, y: y / 2 }]),
    );
    origin.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: to, y }]));
    origin.dispatchEvent(touchEvent('touchend', [], [{ id: 1, x: to, y }]));
  });
}

beforeEach(() => {
  testStorage.clear();
  useChatStore.getState().setSelectionAttachment(null);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove());
  useCanvasStore.setState({
    nodes: [],
    edges: [],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace(),
  });
  root = null;
  container = null;
});

describe('ExpandedNodePanel edge navigation', () => {
  it('does not clear a selection attachment owned by another node', () => {
    renderPanel([canvasNode('a', 'Alpha')], [], true);
    useChatStore.getState().setSelectionAttachment({
      type: 'image',
      source: 'excerpt',
      url: 'https://example.test/capture.png',
      originNodeId: 'pdf-node',
    });

    act(() => root?.unmount());
    root = null;

    expect(useChatStore.getState().selectionAttachment?.originNodeId).toBe(
      'pdf-node',
    );
  });

  it('clears a selection attachment owned by the unmounted node', () => {
    renderPanel([canvasNode('a', 'Alpha')], [], true);
    useChatStore.getState().setSelectionAttachment({
      type: 'text',
      source: 'excerpt',
      content: 'Selected text',
      originNodeId: 'a',
    });

    act(() => root?.unmount());
    root = null;

    expect(useChatStore.getState().selectionAttachment).toBeNull();
  });

  it('reports persistent content mutations to its preview owner', () => {
    const onCommit = vi.fn();
    renderPanel([canvasNode('a', 'Alpha')], [], true, onCommit);

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="mutate-node"]')
        ?.click(),
    );

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('uses compact chrome only when embedded in Preview Workspace', () => {
    renderPanel([canvasNode('a', 'Alpha')], [], true);

    const header = container?.querySelector(
      '[data-testid="expanded-node-header"]',
    );
    expect(header?.classList.contains('h-9')).toBe(true);
    expect(header?.classList.contains('px-2')).toBe(true);
    expect(header?.classList.contains('border-b')).toBe(false);
    const renameTitle = header?.querySelector<HTMLElement>(
      '[aria-label="Rename node"]',
    );
    expect(renameTitle?.textContent).toBe('Alpha');
    expect(renameTitle?.classList.contains('text-fg-subtle')).toBe(true);
    expect(renameTitle?.classList.contains('text-xs')).toBe(true);
    act(() => renameTitle?.click());
    expect(header?.querySelector<HTMLInputElement>('input')?.value).toBe(
      'Alpha',
    );
    expect(
      header?.querySelector<HTMLButtonElement>('[aria-label="Close"]'),
    ).toBeNull();
    expect(header?.querySelector('.h-5.w-px')).toBeNull();
    expect(container?.firstElementChild?.classList.contains('border-l')).toBe(
      false,
    );
  });

  it('lets the embedded title use the available header width', () => {
    renderPanel(
      [canvasNode('a', 'A title that can use the free space')],
      [],
      true,
    );

    const renameTitle = container?.querySelector<HTMLElement>(
      '[aria-label="Rename node"]',
    );
    const tooltipWrapper = renameTitle?.parentElement;
    const titleRegion = tooltipWrapper?.parentElement;
    const leftHeaderRegion = titleRegion?.parentElement;

    expect(leftHeaderRegion?.classList.contains('flex-1')).toBe(true);
    expect(titleRegion?.classList.contains('flex-1')).toBe(true);
    expect(tooltipWrapper?.classList.contains('min-w-0')).toBe(true);
    expect(tooltipWrapper?.classList.contains('max-w-full')).toBe(true);
    expect(renameTitle?.classList.contains('max-w-full')).toBe(true);
    expect(renameTitle?.classList.contains('max-w-40')).toBe(false);
  });

  it('keeps the full header in the legacy layout', () => {
    renderPanel([canvasNode('a', 'Alpha')], []);

    const header = container?.querySelector(
      '[data-testid="expanded-node-header"]',
    );
    expect(header?.classList.contains('h-12')).toBe(true);
    expect(header?.classList.contains('px-3')).toBe(true);
    expect(header?.classList.contains('border-b')).toBe(true);
    expect(
      header?.querySelector<HTMLButtonElement>('[aria-label="Close"]'),
    ).not.toBeNull();
    expect(container?.firstElementChild?.classList.contains('border-l')).toBe(
      true,
    );
  });

  it('groups available relationships behind one menu', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
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
    );

    const navigationButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    expect(navigationButton).not.toBeNull();

    act(() => navigationButton?.click());
    const connectedItem =
      document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    act(() => connectedItem?.click());

    expect(expandedNodeId()).toBe('b');
  });

  it('opens a sole downstream neighbor', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );

    dispatchArrow(window, 'ArrowRight');

    expect(expandedNodeId()).toBe('b');
    expect(
      useCanvasStore
        .getState()
        .nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual([]);
  });

  it('releases the relationship menu so arrow navigation can continue', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
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

    expect(expandedNodeId()).toBe('b');
    expect(document.activeElement).not.toBe(navigationButton);

    dispatchArrow(document.body, 'ArrowLeft');
    expect(expandedNodeId()).toBe('a');
  });

  it('opens a stable chooser for multiple neighbors and selects one', () => {
    renderPanel(
      [
        canvasNode('a', 'Alpha'),
        canvasNode('c', 'Gamma'),
        canvasNode('b', 'Beta'),
      ],
      [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c')],
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
    expect(expandedNodeId()).toBe('b');
    expect(
      useCanvasStore
        .getState()
        .nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual([]);
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
    );
    const input = document.createElement('input');
    document.body.appendChild(input);

    dispatchArrow(input, 'ArrowLeft');

    expect(expandedNodeId()).toBe('a');
    input.remove();
  });
});

describe('ExpandedNodePanel swipe navigation', () => {
  it('opens the downstream neighbor on a leftward touch swipe', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );

    swipe(240, 40);

    expect(expandedNodeId()).toBe('b');
  });

  it('opens the upstream neighbor on a rightward touch swipe', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('b-a', 'b', 'a')],
    );

    swipe(40, 240);

    expect(expandedNodeId()).toBe('b');
  });

  it('offers a chooser when several neighbors share a direction', () => {
    renderPanel(
      [
        canvasNode('a', 'Alpha'),
        canvasNode('c', 'Gamma'),
        canvasNode('b', 'Beta'),
      ],
      [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c')],
    );

    swipe(240, 40);

    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    expect(items.map((item) => item.textContent)).toEqual(['Gamma', 'Beta']);
  });

  it('leaves mouse drags to text selection', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const body = previewBody();

    act(() => {
      body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 240 }),
      );
      body.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40 }),
      );
      body.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, clientX: 40 }),
      );
    });

    expect(expandedNodeId()).toBe('a');
  });

  it('keeps working while the note editor holds focus', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 0;
    const paragraph = document.createElement('p');
    editor.appendChild(paragraph);
    previewBody().appendChild(editor);
    act(() => editor.focus());
    expect(document.activeElement).toBe(editor);

    swipe(240, 40, 0, paragraph);

    expect(expandedNodeId()).toBe('b');
  });

  it('yields to controls that own a horizontal drag', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    previewBody().appendChild(slider);

    swipe(240, 40, 0, slider);

    expect(expandedNodeId()).toBe('a');
  });

  it('hands a vertical drag back to native scrolling', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );

    // Starts downwards, so the axis locks to vertical before drifting sideways.
    swipe(240, 40, 400);

    expect(expandedNodeId()).toBe('a');
  });

  it('abandons the swipe once a second finger joins', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const body = previewBody();

    act(() => {
      body.dispatchEvent(touchEvent('touchstart', [{ id: 1, x: 240 }]));
      body.dispatchEvent(
        touchEvent('touchmove', [
          { id: 1, x: 140 },
          { id: 2, x: 260 },
        ]),
      );
      body.dispatchEvent(touchEvent('touchmove', [{ id: 1, x: 40 }]));
      body.dispatchEvent(touchEvent('touchend', [], [{ id: 1, x: 40 }]));
    });

    expect(expandedNodeId()).toBe('a');
  });

  it('ignores a swipe that never leaves the starting area', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );

    swipe(240, 220);

    expect(expandedNodeId()).toBe('a');
  });
});
