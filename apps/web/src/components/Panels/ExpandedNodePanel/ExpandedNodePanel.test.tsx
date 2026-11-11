// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
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
const previewCallbacks = vi.hoisted(() => ({
  onDataChange: undefined as
    | ((patch: Record<string, unknown>) => void)
    | undefined,
}));

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
    readOnly,
    data,
    scrollHeader,
    searchNodeId,
  }: {
    id?: string;
    onDataChange?: (patch: Record<string, unknown>) => void;
    readOnly?: boolean;
    data: Record<string, unknown>;
    scrollHeader?: ReactNode;
    searchNodeId?: string;
  }) => {
    previewCallbacks.onDataChange = onDataChange;
    return (
      <div
        data-preview-node-id={id}
        data-preview-read-only={readOnly}
        data-preview-content={String(data.content ?? '')}
        data-preview-search-id={searchNodeId}
      >
        {scrollHeader}
        <button
          type="button"
          data-testid="mutate-node"
          disabled={readOnly}
          onClick={() => onDataChange?.({ content: 'Updated' })}
        />
      </div>
    );
  },
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

it('edits an owned Note with its real identity, preserving PDF text and provenance', () => {
  const update = vi
    .spyOn(useCanvasStore.getState(), 'updateNodeData')
    .mockImplementation(() => {});
  renderPanel(
    [
      {
        ...canvasNode('a', 'Paper'),
        type: 'note',
        data: {
          label: 'Paper',
          content: 'Existing authored notes',
        },
      },
      {
        ...canvasNode('pdf', 'Paper'),
        type: 'pdf',
        data: { noteNodeId: 'a', content: 'Extracted' },
      },
    ],
    [],
    true,
    undefined,
  );
  expect(
    container
      ?.querySelector('[data-preview-content]')
      ?.getAttribute('data-preview-content'),
  ).toBe('Existing authored notes');
  expect(
    container
      ?.querySelector('[data-search-scope="node"]')
      ?.getAttribute('data-search-node-id'),
  ).toBe('a');
  expect(
    container
      ?.querySelector('[data-preview-content]')
      ?.getAttribute('data-preview-search-id'),
  ).toBe('a');
  expect(
    container
      ?.querySelector('[data-preview-content]')
      ?.hasAttribute('data-preview-node-id'),
  ).toBe(true);
  act(() =>
    previewCallbacks.onDataChange?.({
      content: 'New owned notes',
      provenance: {},
    }),
  );
  expect(update).toHaveBeenCalledWith('a', {
    content: 'New owned notes',
    provenance: {},
  });
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  expect(useCanvasStore.getState().nodes[1].data.content).toBe('Extracted');
  update.mockRestore();
});

it.each([undefined, ''])(
  'shows an empty editor for missing or cleared notes (%s), not extracted text',
  (content) => {
    renderPanel(
      [
        {
          ...canvasNode('a', 'Paper'),
          type: 'note',
          data: { content },
        },
      ],
      [],
      true,
      undefined,
    );
    expect(
      container
        ?.querySelector('[data-preview-content]')
        ?.getAttribute('data-preview-content'),
    ).toBe('');
  },
);

function dispatchArrow(target: EventTarget, key: 'ArrowLeft' | 'ArrowRight') {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

it('keeps the PDF properties toggle in the toolbar and the list inside the renderer', () => {
  renderPanel(
    [
      {
        ...canvasNode('a', 'Paper'),
        type: 'pdf',
        data: { label: 'Paper', properties: { Venue: 'UIST' } },
      },
    ],
    [],
    true,
  );
  const header = container?.querySelector(
    '[data-testid="expanded-node-header"]',
  );
  const toggle = header?.querySelector<HTMLButtonElement>(
    '[aria-controls][aria-expanded]',
  );
  expect(toggle).not.toBeNull();
  expect(toggle?.textContent).toBe('');
  expect(
    header?.querySelector('[data-preview-header-actions]')?.textContent,
  ).not.toContain('Notes');
  const region = document.getElementById(
    toggle?.getAttribute('aria-controls') ?? '',
  );
  expect(region?.hidden).toBe(true);
  expect(header?.contains(region)).toBe(false);
  expect(
    container?.querySelector('[data-preview-node-id]')?.contains(region),
  ).toBe(true);
  act(() => toggle?.click());
  expect(region?.hidden).toBe(false);
  expect(region?.querySelector('button')?.textContent).toBe('Add notes');
  expect(region?.querySelector('[data-property-name="Add notes"]')).toBeNull();
  expect(region?.textContent).toContain('UIST');
  act(() => toggle?.click());
  expect(region?.hidden).toBe(true);
});

it('uses an icon-only Note disclosure that opens properties without a PDF notes action', () => {
  renderPanel(
    [
      {
        ...canvasNode('a', 'Reading note'),
        type: 'note',
        data: { label: 'Reading note', properties: { Topic: 'Canvas' } },
      },
    ],
    [],
    true,
  );
  const toggle = container?.querySelector<HTMLButtonElement>(
    '[aria-controls][aria-expanded]',
  );
  const region = document.getElementById(
    toggle?.getAttribute('aria-controls') ?? '',
  );
  expect(toggle?.textContent).toBe('');
  expect(toggle?.getAttribute('aria-label')).toBe('Expand properties');
  expect(region?.hidden).toBe(true);
  act(() => toggle?.click());
  expect(toggle?.getAttribute('aria-label')).toBe('Collapse properties');
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(region?.hidden).toBe(false);
  expect(region?.textContent).toContain('Canvas');
  expect(region?.textContent).not.toContain('Add notes');
  expect(region?.textContent).not.toContain('Open notes');
  act(() => toggle?.click());
  expect(toggle?.getAttribute('aria-label')).toBe('Expand properties');
  expect(region?.hidden).toBe(true);
});

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
  useCanvasStore.setState({ canvasAccess: null });
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
  it('consumes a denied rename request so later write access cannot reopen it', () => {
    useCanvasStore.setState({
      canvasAccess: { canvasId: CANVAS_ID, write: false, manage: false },
    });
    renderPanel([canvasNode('a', 'Alpha')], [], true);
    const handled = vi.fn();
    act(() =>
      root?.render(
        <ExpandedNodePanel
          embedded
          renameRequestNonce={3}
          onRenameRequestHandled={handled}
        />,
      ),
    );
    expect(handled).toHaveBeenCalledOnce();
    expect(handled).toHaveBeenCalledWith(3);
    expect(container?.querySelector('input')).toBeNull();
    act(() =>
      useCanvasStore.setState({
        canvasAccess: { canvasId: CANVAS_ID, write: true, manage: false },
      }),
    );
    expect(container?.querySelector('input')).toBeNull();
    expect(handled).toHaveBeenCalledOnce();
    act(() =>
      root?.render(
        <ExpandedNodePanel
          embedded
          renameRequestNonce={4}
          onRenameRequestHandled={handled}
        />,
      ),
    );
    expect(container?.querySelector('input')).not.toBeNull();
    expect(handled).toHaveBeenCalledWith(4);
  });

  it('renders a viewer preview without content or node-title editing', () => {
    useCanvasStore.setState({
      canvasAccess: { canvasId: CANVAS_ID, write: false, manage: false },
    });
    const onCommit = vi.fn();
    renderPanel([canvasNode('a', 'Alpha')], [], true, onCommit);
    expect(
      container?.querySelector('[data-preview-read-only="true"]'),
    ).not.toBeNull();
    act(() =>
      container
        ?.querySelector<HTMLElement>('[aria-label="Rename node"]')
        ?.click(),
    );
    expect(container?.querySelector('input')).toBeNull();
    expect(previewCallbacks.onDataChange).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels an open title edit and ignores retained content callbacks after permission loss', () => {
    useCanvasStore.setState({
      canvasAccess: { canvasId: CANVAS_ID, write: true, manage: false },
    });
    const onCommit = vi.fn();
    renderPanel([canvasNode('a', 'Alpha')], [], true, onCommit);
    const retainedChange = previewCallbacks.onDataChange;
    expect(retainedChange).toBeDefined();
    act(() =>
      container
        ?.querySelector<HTMLElement>('[aria-label="Rename node"]')
        ?.click(),
    );
    expect(container?.querySelector('input')).not.toBeNull();
    act(() =>
      useCanvasStore.setState({
        canvasAccess: { canvasId: CANVAS_ID, write: false, manage: false },
      }),
    );
    expect(container?.querySelector('input')).toBeNull();
    act(() => retainedChange?.({ content: 'Forbidden' }));
    expect(useCanvasStore.getState().nodes[0].data).toEqual({ label: 'Alpha' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps a compact gap between navigation and the title without reserving an empty button slot', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('ab', 'a', 'b')],
      true,
    );
    const header = container?.querySelector(
      '[data-testid="expanded-node-header"]',
    );
    const titleGroup = header?.firstElementChild;
    expect(header?.classList.contains('px-2.5')).toBe(true);
    expect(titleGroup?.classList.contains('gap-1.5')).toBe(true);
    expect(titleGroup?.firstElementChild?.classList.contains('w-3.5')).toBe(
      true,
    );
    const trigger = titleGroup?.querySelector('[aria-haspopup="menu"]');
    expect(trigger?.classList.contains('min-w-6')).toBe(true);
    expect(trigger?.classList.contains('[&_svg]:w-3.25')).toBe(true);
    expect(titleGroup?.children.length).toBe(3);
    expect(titleGroup?.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    act(() => useCanvasStore.setState({ edges: [] }));
    expect(titleGroup?.children.length).toBe(2);
    expect(
      titleGroup
        ?.querySelector('[data-preview-header-leading-actions]')
        ?.classList.contains('empty:hidden'),
    ).toBe(true);
    expect(titleGroup?.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(titleGroup?.textContent).toBe('Alpha');
  });

  it('uses the shared title control in embedded and standalone headers', () => {
    renderPanel([canvasNode('a', 'Alpha')], [], true);
    const selector = '[data-testid="expanded-node-header"] button[aria-label]';
    const host = container;
    if (!host) throw new Error('Missing panel');
    const embeddedTitle = host.querySelector<HTMLButtonElement>(selector);
    if (!embeddedTitle) throw new Error('Missing embedded title');
    const embeddedClasses = embeddedTitle.className;
    expect(embeddedClasses).toContain('text-sm');
    expect(embeddedClasses).toContain('font-normal');
    expect(embeddedClasses).toContain('-ml-1.25');
    act(() => root?.render(<ExpandedNodePanel embedded={false} />));
    const standaloneTitle = host.querySelector<HTMLButtonElement>(selector);
    if (!standaloneTitle) throw new Error('Missing standalone title');
    expect(standaloneTitle.className).toBe(embeddedClasses);
    act(() => standaloneTitle.click());
    const input = host.querySelector('input');
    if (!input) throw new Error('Missing title input');
    expect(input.className).toContain('focus:ring-info');
    expect(input.className).toContain('-ml-1.25');
    expect(document.activeElement).toBe(input);
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(host.querySelector('input')).toBeNull();
    expect(expandedNodeId()).toBe('a');
  });

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
    expect(header?.classList.contains('px-2.5')).toBe(true);
    expect(header?.classList.contains('border-b')).toBe(false);
    const renameTitle = header?.querySelector<HTMLElement>(
      '[aria-label="Rename node"]',
    );
    expect(renameTitle?.textContent).toBe('Alpha');
    expect(renameTitle?.classList.contains('text-fg-muted')).toBe(true);
    expect(renameTitle?.classList.contains('text-sm')).toBe(true);
    expect(renameTitle?.classList.contains('font-normal')).toBe(true);
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
    expect(tooltipWrapper?.classList.contains('flex-1')).toBe(true);
    expect(renameTitle?.classList.contains('w-full')).toBe(true);
    expect(renameTitle?.classList.contains('max-w-full')).toBe(true);
    expect(renameTitle?.classList.contains('max-w-40')).toBe(false);
    act(() => renameTitle?.click());
    const input = container?.querySelector('input');
    expect(input?.classList.contains('w-full')).toBe(true);
    expect(input?.classList.contains('w-64')).toBe(false);
    expect(input?.classList.contains('-ml-1.25')).toBe(true);
  });

  it('keeps the full header in the legacy layout', () => {
    renderPanel([canvasNode('a', 'Alpha')], []);

    const header = container?.querySelector(
      '[data-testid="expanded-node-header"]',
    );
    expect(header?.classList.contains('h-12')).toBe(true);
    expect(header?.classList.contains('px-2.5')).toBe(true);
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
    const heading = [...document.querySelectorAll('[role="menu"] span')].find(
      (element) => element.textContent === 'Destinations',
    );
    const group = heading?.parentElement?.parentElement;
    expect(group?.classList.contains('mt-4')).toBe(true);
    expect(group?.classList.contains('border-t')).toBe(false);
    expect(group?.firstElementChild?.classList.contains('font-normal')).toBe(
      true,
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

  it('restores trigger focus when Escape dismisses the chooser', async () => {
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
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
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

  it('dismisses the connected-node chooser on Tab using the shared menu contract', () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    act(() => trigger?.click());
    const item = document.querySelector('[role="menuitem"]');
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => item?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not reclaim focus after an outside press dismisses the chooser', async () => {
    renderPanel(
      [canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')],
      [edge('a-b', 'a', 'b')],
    );
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Connected node navigation"]',
    );
    act(() => trigger?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const outside = document.createElement('input');
    container?.append(outside);
    act(() => {
      outside.focus();
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
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
