// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Behavioural tests for the tabbed preview surface.
 *
 * The topology reducers are covered in `store/previewWorkspace/model.test.ts`;
 * these assert what the UI adds — which tab is mounted, what the tab strip
 * exposes to assistive technology, and that keyboard navigation follows the
 * ARIA tabs pattern.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { PreviewWorkspace } from './PreviewWorkspace';

import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
      clear: () => values.clear(),
      key: (i: number) => [...values.keys()][i] ?? null,
      get length() {
        return values.size;
      },
    },
  });
});

// The Chat panel pulls in the whole agent stack; the workspace only needs to
// know it dispatched to it.
vi.mock('../ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));

vi.mock('../../Nodes/NodePreviewContent', () => ({
  NodePreviewContent: ({ id }: { id?: string }) => (
    <div data-preview-node-id={id} />
  ),
}));

const CANVAS_ID = 'canvas-1';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function canvasNode(id: string, label: string, type = 'note'): Node {
  return { id, type, position: { x: 0, y: 0 }, data: { label } };
}

const store = () => usePreviewWorkspaceStore.getState();

function openNode(nodeId: string, transient = false) {
  return store().openPreviewTarget(
    { kind: 'node', canvasId: CANVAS_ID, nodeId },
    { transient },
  );
}

function render(nodes: Node[]) {
  useCanvasStore.setState({ nodes, canvasId: CANVAS_ID });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PreviewWorkspace />));
}

const tabs = () =>
  Array.from(container?.querySelectorAll('[role="tab"]') ?? []);
const activeTabName = () =>
  container
    ?.querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute('aria-label');
const mountedNodeId = () =>
  container
    ?.querySelector('[data-preview-node-id]')
    ?.getAttribute('data-preview-node-id');

beforeEach(() => {
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('g1'),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useCanvasStore.setState({ nodes: [], canvasId: '' });
});

describe('tab strip', () => {
  it('shows one tab per open target and mounts only the active one', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(tabs()).toHaveLength(2);
    expect(mountedNodeId()).toBe('b');
    expect(container?.querySelectorAll('[data-preview-node-id]')).toHaveLength(
      1,
    );
  });

  it('derives the title from the node, so a rename propagates', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);
    expect(tabs()[0].textContent).toContain('Alpha');

    act(() => {
      useCanvasStore.setState({ nodes: [canvasNode('a', 'Renamed')] });
    });

    expect(tabs()[0].textContent).toContain('Renamed');
  });

  it('falls back to the untitled label for an unnamed node', () => {
    openNode('a');
    render([canvasNode('a', '')]);

    expect(tabs()[0].textContent).toContain('Untitled');
  });

  it('carries the node type in the accessible name', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha', 'pdf')]);

    expect(tabs()[0].getAttribute('aria-label')).toBe('Alpha (pdf)');
  });

  it('wires each tab to its panel', () => {
    openNode('a');
    render([canvasNode('a', 'Alpha')]);

    const panelId = tabs()[0].getAttribute('aria-controls');
    const panel = container?.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe(panelId);
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
  });
});

describe('activation', () => {
  it('switches the mounted panel on click', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    act(() =>
      tabs()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(mountedNodeId()).toBe('a');
  });

  it('closes a tab from its close control without touching the others', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    const close = tabs()[1].querySelector('button');
    act(() => close?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(tabs()).toHaveLength(1);
    expect(mountedNodeId()).toBe('a');
  });

  it('promotes a transient tab on double click', () => {
    const tabId = openNode('a', true);
    render([canvasNode('a', 'Alpha')]);
    expect(store().workspace.tabs[tabId].transient).toBe(true);

    act(() =>
      tabs()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );

    expect(store().workspace.tabs[tabId].transient).toBe(false);
  });

  it('reuses the inspection slot while browsing transiently', () => {
    openNode('a', true);
    openNode('b', true);
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(tabs()).toHaveLength(1);
    expect(mountedNodeId()).toBe('b');
  });
});

describe('keyboard', () => {
  function arrow(key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Delete') {
    act(() => {
      // The focused tab owns strip navigation, so the event starts there.
      container
        ?.querySelector('[role="tab"][aria-selected="true"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('moves between tabs with arrow keys', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    arrow('ArrowLeft');

    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('wraps around the ends', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    // Active is the last tab, so ArrowRight wraps to the first.
    arrow('ArrowRight');

    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('jumps to the ends with Home and End', () => {
    openNode('a');
    openNode('b');
    openNode('c');
    render([
      canvasNode('a', 'Alpha'),
      canvasNode('b', 'Beta'),
      canvasNode('c', 'Gamma'),
    ]);

    arrow('Home');
    expect(activeTabName()).toBe('Alpha (note)');

    arrow('End');
    expect(activeTabName()).toBe('Gamma (note)');
  });

  it('closes the active tab with Delete', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    arrow('Delete');

    expect(tabs()).toHaveLength(1);
    expect(activeTabName()).toBe('Alpha (note)');
  });

  it('keeps exactly one tab in the tab order', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(
      tabs().filter((t) => t.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
  });
});

describe('split', () => {
  it('renders one group until a tab is opened to the side', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(1);

    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(2);
    expect(container?.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('mounts the active tab of each group', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const mounted = Array.from(
      container?.querySelectorAll('[data-preview-node-id]') ?? [],
    ).map((el) => el.getAttribute('data-preview-node-id'));
    expect(mounted).toEqual(['a', 'b']);
  });

  it('nudges the split ratio from the separator keyboard', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });
    const before = store().workspace.splitRatio;

    act(() => {
      container
        ?.querySelector('[role="separator"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
    });

    expect(store().workspace.splitRatio).toBeLessThan(before);
  });

  it('collapses back to one group when the side group empties', () => {
    openNode('a');
    openNode('b');
    render([canvasNode('a', 'Alpha'), canvasNode('b', 'Beta')]);
    act(() => {
      store().openPreviewTarget(
        { kind: 'node', canvasId: CANVAS_ID, nodeId: 'b' },
        { openToSide: true },
      );
    });

    const sideTab = store().workspace.groups[1].tabIds[0];
    act(() => store().closeTab(sideTab));

    expect(container?.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });
});

describe('target resolution', () => {
  it('dispatches a chat target to the Chat renderer', () => {
    store().openPreviewTarget({
      kind: 'chat',
      canvasId: CANVAS_ID,
      threadId: 'thread-1',
    });
    render([]);

    expect(
      container?.querySelector('[data-testid="chat-panel"]'),
    ).not.toBeNull();
  });

  it('reports a node that disappeared instead of rendering a blank panel', () => {
    openNode('gone');
    render([]);

    expect(container?.textContent).toContain('no longer available');
  });

  it('shows the empty state when nothing is open', () => {
    render([]);

    expect(container?.textContent).toContain('Double-click a node');
  });
});
