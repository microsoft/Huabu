// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpacePreviewNode } from './SpacePreviewNode';
import { OPEN_SPACE_SHORTCUT_EVENT } from './spaceShortcutEvents';

import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  target: {
    title: 'Research',
    nodeCount: undefined as number | undefined,
    updatedAt: undefined as number | undefined,
    status: 'ready',
    error: null as string | null,
    retry: vi.fn(),
  },
  state: {
    nodes: [] as Node[],
    _setStateNoAutosave: vi.fn(),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('./useSpaceShortcutTarget', () => ({
  useSpaceShortcutTarget: () => mocks.target,
}));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: () => mocks.state },
}));
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: { nodeLookup: Map<string, Node> }) => unknown) =>
    selector({
      nodeLookup: new Map(mocks.state.nodes.map((node) => [node.id, node])),
    }),
}));
vi.mock('@/utils/node/textMeasure', () => ({
  measureTextContent: (text: string) => ({ width: text.length * 16 }),
}));
vi.mock('@/components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/Nodes/NodeWrapper', () => ({
  NodeWrapper: ({
    children,
    actions,
    onDoubleClick,
  }: {
    children: ReactNode;
    actions: ReactNode;
    onDoubleClick: () => void;
  }) => (
    <div data-wrapper onDoubleClick={onDoubleClick}>
      {actions}
      {children}
    </div>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.title = 'Research';
  mocks.target.nodeCount = undefined;
  mocks.target.updatedAt = undefined;
  mocks.target.status = 'ready';
  mocks.target.error = null;
  mocks.state.nodes = [
    {
      id: 'shortcut',
      type: 'spacePreview',
      position: { x: 1, y: 2 },
      data: {
        type: 'spacePreview',
        targetCanvasId: 'target',
        widthMode: 'auto',
      },
      style: { width: 360 },
    },
  ];
  mocks.state._setStateNoAutosave.mockImplementation((patch) =>
    Object.assign(mocks.state, patch),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function render(widthMode: 'auto' | 'fixed' = 'auto') {
  act(() =>
    root.render(
      <SpacePreviewNode
        id="shortcut"
        type="spacePreview"
        selected
        data={{ type: 'spacePreview', targetCanvasId: 'target', widthMode }}
        dragging={false}
        draggable
        selectable
        deletable
        isConnectable
        zIndex={0}
        positionAbsoluteX={1}
        positionAbsoluteY={2}
      />,
    ),
  );
}
function open() {
  act(() =>
    host
      .querySelector<HTMLElement>('[data-wrapper]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  );
  act(() =>
    window.dispatchEvent(
      new CustomEvent(OPEN_SPACE_SHORTCUT_EVENT, {
        detail: { nodeId: 'shortcut' },
      }),
    ),
  );
  act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="spacePreview.openSpace"]')
      ?.click(),
  );
}
describe('Space Shortcut production node', () => {
  it('shows known summaries without treating unknown counts as zero', () => {
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
    mocks.target.nodeCount = 0;
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).not.toBeNull();
    mocks.target.status = 'missing';
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
  });

  it('uses bounded derived width without an authored geometry command', () => {
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(240);
    mocks.target.title = 'A very long target title that cannot fit on one line';
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(480);
    expect(mocks.state.nodes[0].data.widthMode).toBe('auto');
  });

  it('keeps custom width across target renames', () => {
    render('fixed');
    mocks.target.title = 'Renamed Space';
    render('fixed');
    expect(mocks.state.nodes[0].style?.width).toBe(360);
    expect(mocks.state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Renamed Space');
  });

  it('recomputes stale automatic geometry after history restore but does not fight a drag', () => {
    render();
    mocks.state.nodes[0] = { ...mocks.state.nodes[0], style: { width: 400 } };
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(240);
    mocks.state.nodes[0] = {
      ...mocks.state.nodes[0],
      style: { width: 320 },
      resizing: true,
    };
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(320);
    mocks.state.nodes[0] = { ...mocks.state.nodes[0], resizing: false };
    render('fixed');
    expect(mocks.state.nodes[0].style?.width).toBe(320);
  });

  it('shares navigation across double click, Enter, and toolbar', () => {
    render();
    open();
    expect(mocks.navigate.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['/canvas/target']),
    );
  });

  it('keeps cached targets openable while surfacing background refresh errors and retry', () => {
    mocks.target.error = 'Offline';
    render();
    open();
    expect(mocks.navigate).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Offline');
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="spacePreview.retry"]')
        ?.click(),
    );
    expect(mocks.target.retry).toHaveBeenCalledOnce();
  });

  it.each(['loading', 'missing', 'error'])(
    'blocks all entry paths when %s',
    (status) => {
      mocks.target.status = status;
      render();
      open();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(
        host.querySelector(`[data-target-status="${status}"]`),
      ).not.toBeNull();
      if (status === 'error') {
        act(() =>
          host
            .querySelector<HTMLButtonElement>(
              '[aria-label="spacePreview.retry"]',
            )
            ?.click(),
        );
        expect(mocks.target.retry).toHaveBeenCalledOnce();
      }
    },
  );
});
