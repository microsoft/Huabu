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
import type { DndContextProps, DragEndEvent } from '@dnd-kit/core';
import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  openPreviewNode: vi.fn(() => 'tab-1'),
  requestChatOpen: vi.fn(),
  revealNodesOnCanvas: vi.fn(),
  toast: vi.fn(),
  startPointerDrag: vi.fn(),
  reorderNodes: vi.fn(),
  moveNodeIntoFrame: vi.fn(),
  moveNodeOutOfFrame: vi.fn(),
  dnd: {} as DndContextProps,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('lottie-react', () => ({ default: () => null }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }: DndContextProps) => {
    Object.assign(mocks.dnd, props);
    return children;
  },
  MouseSensor: class MouseSensor {},
  TouchSensor: class TouchSensor {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
}));
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  useSortable: () => ({
    listeners: {
      onMouseDown: mocks.startPointerDrag,
      onTouchStart: mocks.startPointerDrag,
    },
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
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
const {
  reorderNodes: reorderLiveNodes,
  moveNodeIntoFrame: moveLiveNodesIntoFrame,
  moveNodeOutOfFrame: moveLiveNodesOutOfFrame,
} = useCanvasStore.getState();
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

function dragEvent(
  activeId: string,
  overId: string,
  intent: 'before' | 'after' | 'into' = 'before',
): DragEndEvent {
  return {
    activatorEvent: new MouseEvent('mousedown'),
    active: {
      id: activeId,
      data: { current: {} },
      rect: { current: { initial: null, translated: null } },
    },
    over: {
      id: overId,
      data: { current: {} },
      rect: { top: 0, bottom: 34, left: 0, right: 200, width: 200, height: 34 },
      disabled: false,
    },
    delta: { x: 0, y: 34 },
    collisions: [{ id: overId, data: { intent } }],
  };
}

async function renderTree(
  items: DataSourceTreeItem[],
  options?: {
    isFilterActive?: boolean;
    liveItems?: DataSourceTreeItem[];
    navigationState?: {
      focusedId: string | null;
      selectionAnchorId: string | null;
    };
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
    reorderNodes: mocks.reorderNodes,
    moveNodeIntoFrame: mocks.moveNodeIntoFrame,
    moveNodeOutOfFrame: mocks.moveNodeOutOfFrame,
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
        navigationState={options?.navigationState}
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
  mocks.startPointerDrag.mockClear();
  mocks.reorderNodes.mockClear();
  mocks.moveNodeIntoFrame.mockClear();
  mocks.moveNodeOutOfFrame.mockClear();
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
  it('leaves vertical list padding to its host instead of adding a second inset', async () => {
    await renderTree([item('note-1', 'note')]);
    const tree = container.querySelector('[role="tree"]');
    expect(tree?.className).toBe('flex flex-col');
  });

  it('restores roving focus and range selection after a list remount', async () => {
    const items = [
      item('first', 'note'),
      item('middle', 'note'),
      item('last', 'note'),
    ];
    const navigationState = {
      focusedId: null as string | null,
      selectionAnchorId: null as string | null,
    };
    await renderTree(items, { navigationState });
    act(() => row('middle').click());
    act(() => row('middle').focus());
    act(() => root.render(null));
    expect(navigationState).toEqual({
      focusedId: 'middle',
      selectionAnchorId: 'middle',
    });
    const { selectNodes } = await renderTree(items, { navigationState });
    expect(row('middle').tabIndex).toBe(0);
    act(() =>
      row('last').dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true }),
      ),
    );
    expect(selectNodes).toHaveBeenLastCalledWith(['middle', 'last'], false);
  });

  it('selects, minimally reveals, and transiently opens a preview-capable node', async () => {
    const { selectNodes } = await renderTree([item('note-1', 'note')]);

    act(() => row('note-1').click());

    expect(selectNodes).toHaveBeenCalledWith(['note-1'], false);
    expect(mocks.revealNodesOnCanvas).toHaveBeenCalledOnce();
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1', {
      transient: true,
    });
    expect(mocks.openPreviewNode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revealNodesOnCanvas.mock.invocationCallOrder[0],
    );
  });

  it('opens Preview when Canvas is not mounted', async () => {
    await renderTree([item('note-1', 'note')]);
    act(() =>
      useCanvasStore.setState({ rfInstance: null, canvasWrapper: null }),
    );

    act(() => row('note-1').click());

    expect(mocks.revealNodesOnCanvas).not.toHaveBeenCalled();
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1', {
      transient: true,
    });
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
    expect(row('note-1').getAttribute('aria-selected')).toBe('true');
    expect(row('note-1').querySelector('.bg-info-bg')).not.toBeNull();
    expect(row('note-1').querySelector('.ring-info.ring-1')).toBeNull();
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
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('question-1', {
      transient: true,
    });
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
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1', {
      transient: true,
    });
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
    expect(row('frame-1').querySelector('.lucide-grip-vertical')).toBeNull();

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
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1', {
      transient: true,
    });

    mocks.openPreviewNode.mockClear();
    act(() =>
      row('note-1').dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      ),
    );
    expect(mocks.openPreviewNode).toHaveBeenCalledWith('note-1', {
      transient: true,
    });

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

describe('CanvasLayerTree row drag restrictions', () => {
  it.each(['mousedown', 'touchstart'])(
    'starts %s dragging an ordinary row but not a filtered row',
    async (eventType) => {
      const items = [item('note-1', 'note')];
      await renderTree(items);
      act(() =>
        row('note-1').dispatchEvent(new Event(eventType, { bubbles: true })),
      );
      expect(mocks.startPointerDrag).toHaveBeenCalledOnce();

      await renderTree(items, { isFilterActive: true });
      mocks.startPointerDrag.mockClear();
      act(() =>
        row('note-1').dispatchEvent(new Event(eventType, { bubbles: true })),
      );
      expect(mocks.startPointerDrag).not.toHaveBeenCalled();
    },
  );

  it.each(['mousedown', 'touchstart'])(
    'does not start %s dragging a descendant of a locked Frame',
    async (eventType) => {
      await renderTree([
        item('frame-1', 'frame', undefined, { locked: true }),
        item('note-1', 'note', 'frame-1'),
      ]);
      act(() =>
        row('note-1').dispatchEvent(new Event(eventType, { bubbles: true })),
      );
      expect(mocks.startPointerDrag).not.toHaveBeenCalled();
    },
  );
});

describe('CanvasLayerTree drag selection and same-parent groups', () => {
  function select(ids: string[]) {
    act(() => {
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((node) => ({
          ...node,
          selected: ids.includes(node.id),
        })),
      }));
    });
  }

  it('selects an unselected drag source without preview, reveal or disclosure', async () => {
    const { selectNodes } = await renderTree([
      item('frame', 'frame'),
      item('other', 'note'),
    ]);
    select(['other']);
    act(() => mocks.dnd.onDragStart?.(dragEvent('frame', 'other')));
    expect(selectNodes).toHaveBeenCalledWith(['frame'], false);
    expect(row('frame').getAttribute('aria-selected')).toBe('true');
    expect(row('frame').getAttribute('data-layer-dragging')).toBe('true');
    expect(row('frame').style.opacity).toBe('');
    expect(mocks.openPreviewNode).not.toHaveBeenCalled();
    expect(mocks.revealNodesOnCanvas).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().collapsedFrameIds.size).toBe(0);
    act(() => mocks.dnd.onDragCancel?.(dragEvent('frame', 'other')));
    expect(row('frame').hasAttribute('data-layer-dragging')).toBe(false);
    expect(row('frame').getAttribute('aria-selected')).toBe('true');
  });

  it('preserves multi-selection and sends all sources in one reorder call', async () => {
    const { selectNodes } = await renderTree(
      ['a', 'target', 'b'].map((id) => item(id, 'note')),
    );
    select(['a', 'b']);
    const event = dragEvent('b', 'target', 'after');
    act(() => mocks.dnd.onDragStart?.(event));
    expect(selectNodes).not.toHaveBeenCalled();
    expect(row('a').getAttribute('data-layer-dragging')).toBe('true');
    expect(row('b').getAttribute('data-layer-dragging')).toBe('true');
    act(() => mocks.dnd.onDragMove?.(event));
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(mocks.reorderNodes).toHaveBeenCalledExactlyOnceWith(
      ['a', 'b'],
      'target',
      'before',
    );
    expect(row('a').hasAttribute('data-layer-dragging')).toBe(false);
    expect(row('b').hasAttribute('data-layer-dragging')).toBe(false);
    expect(mocks.moveNodeIntoFrame).not.toHaveBeenCalled();
    expect(mocks.moveNodeOutOfFrame).not.toHaveBeenCalled();
  });

  it('keeps multi-row drops below the last sibling inside their current Frame', async () => {
    await renderTree([
      item('frame', 'frame'),
      item('a', 'note', 'frame'),
      item('b', 'note', 'frame'),
      item('target', 'note', 'frame'),
    ]);
    select(['a', 'b']);
    const event = dragEvent('a', 'target', 'after');
    act(() => mocks.dnd.onDragStart?.(event));
    act(() => mocks.dnd.onDragMove?.(event));
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(mocks.reorderNodes).toHaveBeenCalledExactlyOnceWith(
      ['a', 'b'],
      'target',
      'before',
    );
    expect(mocks.moveNodeOutOfFrame).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'moves all selected siblings out to the root with a %s drop',
    async (intent) => {
      await renderTree([
        item('frame', 'frame'),
        item('a', 'note', 'frame'),
        item('b', 'note', 'frame'),
        item('target', 'note'),
      ]);
      select(['a', 'b']);
      const event = dragEvent('b', 'target', intent);
      act(() => mocks.dnd.onDragStart?.(event));
      act(() => mocks.dnd.onDragMove?.(event));
      expect(row('target').querySelector('span.right-2')).not.toBeNull();
      act(() => mocks.dnd.onDragEnd?.(event));
      expect(mocks.moveNodeOutOfFrame).toHaveBeenCalledExactlyOnceWith(
        ['a', 'b'],
        {
          nodeId: 'target',
          position: intent === 'before' ? 'after' : 'before',
        },
      );
      expect(mocks.moveNodeIntoFrame).not.toHaveBeenCalled();
      expect(mocks.reorderNodes).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it('revalidates source ancestor locks when releasing a grouped root exit', async () => {
    await renderTree([
      item('frame', 'frame'),
      item('a', 'note', 'frame'),
      item('b', 'note', 'frame'),
      item('target', 'note'),
    ]);
    select(['a', 'b']);
    const event = dragEvent('a', 'target', 'before');
    act(() => mocks.dnd.onDragStart?.(event));
    act(() => mocks.dnd.onDragMove?.(event));
    act(() =>
      useCanvasStore.setState((state) => ({
        moveNodeOutOfFrame: moveLiveNodesOutOfFrame,
        nodes: state.nodes.map((node) =>
          node.id === 'frame'
            ? { ...node, data: { ...node.data, locked: true } }
            : node,
        ),
      })),
    );
    const before = useCanvasStore.getState().nodes;
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(useCanvasStore.getState().nodes).toBe(before);
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), {
      tone: 'warning',
    });
  });

  it.each([1, 2])(
    'revalidates same-parent sorting after an ancestor locks for %s source(s)',
    async (count) => {
      await renderTree([
        item('frame', 'frame'),
        item('a', 'note', 'frame'),
        item('b', 'note', 'frame'),
        item('target', 'note', 'frame'),
      ]);
      select(count === 1 ? ['a'] : ['a', 'b']);
      const event = dragEvent('a', 'target', 'before');
      act(() => mocks.dnd.onDragStart?.(event));
      act(() => mocks.dnd.onDragMove?.(event));
      expect(row('target').querySelector('span.right-2')).not.toBeNull();
      act(() =>
        useCanvasStore.setState((state) => ({
          reorderNodes: reorderLiveNodes,
          nodes: state.nodes.map((node) =>
            node.id === 'frame'
              ? { ...node, data: { ...node.data, locked: true } }
              : node,
          ),
        })),
      );
      const before = useCanvasStore.getState().nodes;
      act(() => mocks.dnd.onDragEnd?.(event));
      expect(useCanvasStore.getState().nodes).toBe(before);
      expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), {
        tone: 'warning',
      });
    },
  );

  it.each(['before', 'after', 'into'] as const)(
    'moves all same-parent sources into another Frame with one %s drop',
    async (intent) => {
      await renderTree([
        item('a', 'note'),
        item('b', 'note'),
        item('frame', 'frame'),
        item('child', 'note', 'frame'),
      ]);
      select(['a', 'b']);
      const event = dragEvent(
        'a',
        intent === 'into' ? 'frame' : 'child',
        intent,
      );
      act(() => mocks.dnd.onDragStart?.(event));
      act(() => mocks.dnd.onDragMove?.(event));
      expect(container.querySelector('.outline-solid')).toBeNull();
      expect(container.querySelector('span.right-2')).not.toBeNull();
      act(() => mocks.dnd.onDragEnd?.(event));
      expect(mocks.reorderNodes).not.toHaveBeenCalled();
      expect(mocks.moveNodeIntoFrame).toHaveBeenCalledExactlyOnceWith(
        ['a', 'b'],
        'frame',
        { nodeId: 'child', position: intent === 'after' ? 'before' : 'after' },
      );
      expect(mocks.moveNodeOutOfFrame).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    'keeps a collapsed target closed during sustained hovering and after a drop for %s source(s)',
    async (count) => {
      vi.useFakeTimers();
      try {
        await renderTree([
          item('source', 'frame'),
          item('a', 'note', 'source'),
          item('b', 'note', 'source'),
          item('target', 'frame'),
          item('child', 'note', 'target'),
        ]);
        act(() =>
          useCanvasStore.setState({ collapsedFrameIds: new Set(['target']) }),
        );
        select(count === 1 ? ['a'] : ['a', 'b']);
        const event = dragEvent('a', 'target', 'into');
        act(() => mocks.dnd.onDragStart?.(event));
        act(() => mocks.dnd.onDragMove?.(event));
        expect(row('target').querySelector('.outline-solid')).not.toBeNull();
        expect(row('target').querySelector('.bg-info-bg')).toBeNull();
        act(() => vi.advanceTimersByTime(350));
        expect(row('target').getAttribute('aria-expanded')).toBe('false');
        expect(row('target').querySelector('.outline-solid')).not.toBeNull();
        expect(row('target').querySelector('span.right-2')).toBeNull();
        act(() => mocks.dnd.onDragEnd?.(event));
        expect(mocks.moveNodeIntoFrame).toHaveBeenCalledExactlyOnceWith(
          count === 1 ? 'a' : ['a', 'b'],
          'target',
          { nodeId: 'child', position: 'after' },
        );
        expect(row('target').getAttribute('aria-expanded')).toBe('false');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('moves saved and newly created root siblings into a Frame together', async () => {
    await renderTree([
      item('a', 'note'),
      item('b', 'note'),
      item('frame', 'frame'),
    ]);
    act(() =>
      useCanvasStore.setState((state) => ({
        nodes: JSON.parse(
          JSON.stringify(
            state.nodes.map((node) =>
              node.id === 'a' ? { ...node, parentId: null } : node,
            ),
          ),
        ),
      })),
    );
    select(['a', 'b']);
    const event = dragEvent('b', 'frame', 'into');
    act(() => mocks.dnd.onDragStart?.(event));
    act(() => mocks.dnd.onDragMove?.(event));
    expect(row('frame').querySelector('span.right-2')).not.toBeNull();
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(mocks.moveNodeIntoFrame).toHaveBeenCalledExactlyOnceWith(
      ['a', 'b'],
      'frame',
      undefined,
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('disables ordinary row hover during the entire drag and restores it on cancellation', async () => {
    await renderTree(['a', 'b', 'target'].map((id) => item(id, 'note')));
    const surface = () => row('target').querySelector('.group');
    expect(surface()?.classList.contains('hover:bg-hover')).toBe(true);
    select(['a', 'b']);
    const event = dragEvent('a', 'target');
    act(() => mocks.dnd.onDragStart?.(event));
    act(() => mocks.dnd.onDragMove?.(event));
    expect(surface()?.classList.contains('hover:bg-hover')).toBe(false);
    act(() => mocks.dnd.onDragCancel?.(event));
    expect(surface()?.classList.contains('hover:bg-hover')).toBe(true);
  });

  it.each(['locked', 'locked-ancestor', 'cycle', 'stale-lock'] as const)(
    'rejects an invalid grouped destination (%s) without a partial move',
    async (reason) => {
      await renderTree([
        item('source', 'frame'),
        item('a', 'frame', 'source'),
        item('b', 'note', 'source'),
        item('outer', 'frame', undefined, {
          locked: reason === 'locked-ancestor',
        }),
        item('target', 'frame', reason === 'cycle' ? 'a' : 'outer', {
          locked: reason === 'locked',
        }),
      ]);
      select(['a', 'b']);
      const event = dragEvent('a', 'target', 'into');
      act(() => mocks.dnd.onDragStart?.(event));
      act(() => mocks.dnd.onDragMove?.(event));
      if (reason === 'stale-lock') {
        act(() =>
          useCanvasStore.setState((state) => ({
            moveNodeIntoFrame: moveLiveNodesIntoFrame,
            nodes: state.nodes.map((node) =>
              node.id === 'target'
                ? { ...node, data: { ...node.data, locked: true } }
                : node,
            ),
          })),
        );
      }
      const before = useCanvasStore.getState().nodes;
      act(() => mocks.dnd.onDragEnd?.(event));
      expect(useCanvasStore.getState().nodes).toBe(before);
      expect(mocks.moveNodeIntoFrame).not.toHaveBeenCalled();
      expect(mocks.reorderNodes).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), {
        tone: 'warning',
      });
    },
  );

  it('announces unsupported mixed-parent selections without partially moving them', async () => {
    await renderTree([
      item('root', 'note'),
      item('frame', 'frame'),
      item('child', 'note', 'frame'),
    ]);
    select(['root', 'child']);
    const event = dragEvent('root', 'frame', 'before');
    act(() => mocks.dnd.onDragStart?.(event));
    expect(mocks.toast).toHaveBeenCalledWith('layers.multiDragSameParentOnly', {
      tone: 'info',
    });
    expect(row('root').hasAttribute('data-layer-dragging')).toBe(false);
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(mocks.reorderNodes).not.toHaveBeenCalled();
  });

  it('rejects stale group members rather than moving a partial group', async () => {
    await renderTree(['a', 'b', 'target'].map((id) => item(id, 'note')));
    select(['a', 'b']);
    const event = dragEvent('a', 'target');
    act(() => mocks.dnd.onDragStart?.(event));
    act(() => mocks.dnd.onDragMove?.(event));
    act(() =>
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.filter((node) => node.id !== 'b'),
      })),
    );
    act(() => mocks.dnd.onDragEnd?.(event));
    expect(mocks.reorderNodes).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('layers.nodeUnavailable', {
      tone: 'warning',
    });
  });
});
