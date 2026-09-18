// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasLayerTree, resolveCollisionY } from './CanvasLayerTree';
import useCanvasStore from '../../../store/canvasStore';
import { usePanelStore } from '../../../store/panelStore';
import { createEmptyWorkspace } from '../../../store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '../../../store/previewWorkspace/store';

import type { DataSourceTreeItem } from './types';
import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  openPreviewNode: vi.fn(() => 'tab-1'),
  requestChatOpen: vi.fn(),
  revealNodesOnCanvas: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('lottie-react', () => ({ default: () => null }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  KeyboardSensor: class KeyboardSensor {},
  PointerSensor: class PointerSensor {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: {},
}));
vi.mock('../../../store/previewWorkspace/actions', () => ({
  openPreviewNode: mocks.openPreviewNode,
}));
vi.mock('./focusNodesOnCanvas', () => ({
  revealNodesOnCanvas: mocks.revealNodesOnCanvas,
}));
vi.mock('../../Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('../../Common/EmptyState', () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

const CANVAS_ID = 'canvas-1';
let container: HTMLDivElement;
let root: Root;

function item(
  id: string,
  type: string,
  parentId?: string,
  data: Record<string, unknown> = {},
): DataSourceTreeItem {
  return {
    id,
    depth: parentId ? 1 : 0,
    node: {
      id,
      type,
      parentId,
      data: { label: id, ...data },
    },
  };
}

function row(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-layer-id="${id}"]`,
  );
  if (!element) throw new Error(`Missing layer row ${id}`);
  return element;
}

async function renderTree(
  items: DataSourceTreeItem[],
  options?: {
    isFilterActive?: boolean;
    liveItems?: DataSourceTreeItem[];
  },
) {
  const nodes = (options?.liveItems ?? items).map(
    ({ node }) =>
      ({
        ...node,
        position: { x: 0, y: 0 },
      }) as Node,
  );
  const selectNodes = vi.fn((ids: string[]) => {
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        selected: ids.includes(node.id),
      })),
    }));
  });
  const canvasWrapper = document.createElement('div');
  Object.defineProperties(canvasWrapper, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  });
  useCanvasStore.setState({
    canvasId: CANVAS_ID,
    nodes,
    collapsedFrameIds: new Set(),
    rfInstance: {} as never,
    canvasWrapper,
    selectNodes,
  });
  usePanelStore.setState({
    isRightCollapsed: false,
    isPreviewFullscreen: false,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('group-1'),
    requestChatOpen: mocks.requestChatOpen,
  });

  await act(async () => {
    root.render(
      <CanvasLayerTree
        items={items}
        getIcon={() => <span />}
        getDisplayName={(node) => node.data.label}
        isFilterActive={options?.isFilterActive}
      />,
    );
  });
  return { selectNodes };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  mocks.openPreviewNode.mockClear();
  mocks.requestChatOpen.mockClear();
  mocks.revealNodesOnCanvas.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useCanvasStore.setState({
    canvasId: '',
    nodes: [],
    collapsedFrameIds: new Set(),
    rfInstance: null,
    canvasWrapper: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: '',
    workspace: createEmptyWorkspace(),
  });
});

describe('CanvasLayerTree activation', () => {
  it('selects, minimally reveals, and opens a preview-capable node', async () => {
    const { selectNodes } = await renderTree([item('note-1', 'note')]);

    act(() => row('note-1').click());

    expect(selectNodes).toHaveBeenCalledWith(['note-1'], false);
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1');
  });

  it('opens Preview when Canvas is not mounted', async () => {
    await renderTree([item('note-1', 'note')]);
    act(() =>
      useCanvasStore.setState({ rfInstance: null, canvasWrapper: null }),
    );

    act(() => row('note-1').click());

    expect(mocks.revealNodesOnCanvas).not.toHaveBeenCalled();
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1');
  });

  it('does not reopen a node already visible in Preview', async () => {
    await renderTree([item('note-1', 'note')]);
    act(() => {
      usePreviewWorkspaceStore.getState().openPreviewTarget({
        kind: 'node',
        canvasId: CANVAS_ID,
        nodeId: 'note-1',
      });
    });

    act(() => row('note-1').click());

    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(row('note-1').querySelector('.ring-info.ring-1')).not.toBeNull();
  });

  it('expands a Frame and collapses it on repeated primary activation', async () => {
    await renderTree([item('frame-1', 'frame')]);
    act(() =>
      useCanvasStore.setState({
        collapsedFrameIds: new Set(['frame-1']),
      }),
    );

    act(() => row('frame-1').click());

    expect(useCanvasStore.getState().collapsedFrameIds.has('frame-1')).toBe(
      false,
    );
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('layers.emptyFrame', {
      tone: 'info',
    });

    act(() => row('frame-1').click());

    expect(useCanvasStore.getState().collapsedFrameIds.has('frame-1')).toBe(
      true,
    );
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
  });

  it('selects an expanded Frame before a later activation collapses it', async () => {
    await renderTree([
      item('frame-1', 'frame'),
      item('note-1', 'note', 'frame-1'),
    ]);

    act(() => row('frame-1').click());

    expect(useCanvasStore.getState().collapsedFrameIds.has('frame-1')).toBe(
      false,
    );

    act(() => row('frame-1').click());

    expect(useCanvasStore.getState().collapsedFrameIds.has('frame-1')).toBe(
      true,
    );
  });

  it('opens only an existing Question conversation', async () => {
    await renderTree([
      item('question-1', 'question', undefined, { threadId: 'thread-1' }),
      item('question-2', 'question'),
    ]);

    act(() => row('question-1').click());
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('question-1');
    expect(mocks.requestChatOpen).toHaveBeenCalledWith('tab-1', 'bottom');

    mocks.openPreviewNode.mockClear();
    act(() => row('question-2').click());
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('layers.nodeFocusedNoPreview', {
      tone: 'info',
    });
  });

  it('expands collapsed ancestors before activating a filtered descendant', async () => {
    const liveItems = [
      item('frame-1', 'frame'),
      { ...item('frame-2', 'frame', 'frame-1'), depth: 1 },
      { ...item('note-1', 'note', 'frame-2'), depth: 2 },
    ];
    await renderTree([{ ...item('note-1', 'note', 'frame-2'), depth: 0 }], {
      isFilterActive: true,
      liveItems,
    });
    act(() =>
      useCanvasStore.setState({
        collapsedFrameIds: new Set(['frame-1', 'frame-2']),
      }),
    );

    act(() => row('note-1').click());

    expect(useCanvasStore.getState().collapsedFrameIds.size).toBe(0);
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1');
  });

  it('does not announce a filtered Frame as empty when live children exist', async () => {
    const frame = item('frame-1', 'frame');
    await renderTree([frame], {
      isFilterActive: true,
      liveItems: [frame, item('note-1', 'note', 'frame-1')],
    });

    act(() => row('frame-1').click());

    expect(mocks.toast).not.toHaveBeenCalledWith('layers.emptyFrame', {
      tone: 'info',
    });
  });

  it('ignores a stale row safely', async () => {
    await renderTree([item('note-1', 'note')]);
    act(() => useCanvasStore.setState({ nodes: [] }));

    act(() => row('note-1').click());

    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('layers.nodeUnavailable', {
      tone: 'warning',
    });
  });
});

describe('CanvasLayerTree collision input', () => {
  it('uses the keyboard collision rectangle when no pointer exists', () => {
    expect(resolveCollisionY(null, { top: 20, height: 40 })).toBe(40);
    expect(resolveCollisionY({ y: 75 }, { top: 20, height: 40 })).toBe(75);
  });
});

describe('CanvasLayerTree keyboard semantics', () => {
  it('uses roving focus and separates activation from disclosure', async () => {
    const items = [
      item('frame-1', 'frame'),
      {
        ...item('note-1', 'note', 'frame-1'),
        depth: 1,
      },
      item('note-2', 'note'),
    ];
    await renderTree(items);

    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(row('frame-1').getAttribute('role')).toBe('treeitem');
    expect(row('frame-1').getAttribute('aria-expanded')).toBe('true');
    expect(row('frame-1').tabIndex).toBe(0);
    expect(
      row('frame-1').querySelector('button[aria-label="layers.reorderNode"]'),
    ).not.toBeNull();

    act(() => row('frame-1').focus());
    act(() =>
      row('frame-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(row('note-1'));

    act(() =>
      row('note-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1');

    mocks.openPreviewNode.mockClear();
    act(() =>
      row('note-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      ),
    );
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1');

    act(() =>
      row('note-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(row('frame-1'));

    act(() =>
      row('frame-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      ),
    );
    expect(useCanvasStore.getState().collapsedFrameIds.has('frame-1')).toBe(
      true,
    );
    expect(row('frame-1').getAttribute('aria-expanded')).toBe('false');
  });
});
