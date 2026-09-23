// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DropdownMenuItem,
  DropdownMenuSubmenu,
} from '@/components/Common/DropdownMenu';
import { resolveSetQuestionCardScale } from '@/handler/canvasCommand/resolvers/resolveSetQuestionCardScale';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import { NodeFloatingToolbar } from './NodeFloatingToolbar';

import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  isNotMouse: false,
  modifierHeld: false,
  previewOpen: false,
  connectable: true,
  active: vi.fn(),
  ancestorClick: vi.fn(),
  canvas: {
    nodes: [] as Node[],
    canvasWrapper: null as HTMLDivElement | null,
    ingestionByNodeId: {} as Record<string, { status: string }>,
    convertNodeType: vi.fn(),
    beginGesture: vi.fn(),
    dispatchUiIntent: vi.fn(),
    onNodeDragStart: vi.fn(),
    onNodeDrag: vi.fn(),
    onNodesChange: vi.fn(),
    onNodeDragStop: vi.fn(),
    cancelActiveNodeDrag: vi.fn(),
  },
}));

vi.mock('@xyflow/react', () => ({
  useInternalNode: () => ({
    internals: { positionAbsolute: { x: 0, y: 0 } },
    measured: { width: 400, height: 300 },
  }),
  useReactFlow: () => ({
    screenToFlowPosition: (point: { x: number; y: number }) => point,
  }),
  useStoreApi: () => ({
    getState: () => ({ nodesConnectable: mocks.connectable }),
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'node.dragToMove' ? 'Drag to move' : key),
  }),
}));
vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (select: (state: typeof mocks.canvas) => unknown) => select(mocks.canvas),
    { getState: () => mocks.canvas },
  ),
}));
vi.mock('@/hooks/useInputMode', () => ({
  useIsNotMouse: () => mocks.isNotMouse,
  readEffectiveInputMode: () => 'pen',
}));
vi.mock('@/hooks/useMultiSelectModifier', () => ({
  useMultiSelectModifierHeld: () => mocks.modifierHeld,
}));
vi.mock('@/handler/canvasInteractionOwner', () => ({
  canTouchClaimViewport: () => true,
}));
vi.mock('@/components/Nodes/shared/height/useHeightMode', () => ({
  useHeightMode: () => 'auto',
}));
vi.mock('@/store/nodeCollapseStore', () => ({
  useNodeCollapseStore: (
    select: (state: { marks: Record<string, never> }) => unknown,
  ) => select({ marks: {} }),
}));
vi.mock('@/store/previewWorkspace/store', () => ({
  usePreviewWorkspaceStore: () => mocks.previewOpen,
}));
vi.mock('@/components/Common/CanvasFloatingPopover', () => ({
  CanvasFloatingPopover: ({
    open,
    className,
    children,
  }: {
    open: boolean;
    className: string;
    children: ReactNode;
  }) => (open ? <div className={className}>{children}</div> : null),
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('NodeFloatingToolbar type-icon drag surface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let focus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isNotMouse = false;
    mocks.modifierHeld = false;
    mocks.previewOpen = false;
    mocks.connectable = true;
    mocks.canvas.ingestionByNodeId = {};
    mocks.canvas.nodes = [
      { id: 'node', selected: true, position: { x: 0, y: 0 }, data: {} },
    ];
    mocks.canvas.canvasWrapper = document.createElement('div');
    mocks.canvas.canvasWrapper.tabIndex = -1;
    document.body.append(mocks.canvas.canvasWrapper);
    focus = vi.spyOn(mocks.canvas.canvasWrapper, 'focus');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mocks.canvas.canvasWrapper?.remove();
    vi.restoreAllMocks();
  });

  function render(
    props: Partial<ComponentProps<typeof NodeFloatingToolbar>> = {},
  ) {
    act(() =>
      root.render(
        <div role="presentation" onClick={mocks.ancestorClick}>
          <NodeFloatingToolbar
            id="node"
            type="video"
            data={{ type: 'video', src: 'video.webm' }}
            dragEnabled
            onDragActiveChange={mocks.active}
            {...props}
          />
        </div>,
      ),
    );
  }

  function handle(selector = 'button[data-node-drag-handle]') {
    const button = container.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error('Missing type-icon drag button');
    let captured: number | null = null;
    button.setPointerCapture = vi.fn((id) => {
      captured = id;
    });
    button.hasPointerCapture = vi.fn((id) => captured === id);
    button.releasePointerCapture = vi.fn(() => {
      captured = null;
    });
    return button;
  }

  function openPanel(label: string) {
    const trigger = container.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    if (!trigger) throw new Error(`Missing ${label} trigger`);
    act(() => trigger.click());
  }

  it.each([
    { nested: false, detail: 1 },
    { nested: false, detail: 0 },
    { nested: true, detail: 1 },
    { nested: true, detail: 0 },
  ])(
    'runs overflow commands before closing without bubbling (nested=$nested, click detail=$detail)',
    ({ nested, detail }) => {
      const command = vi.fn(() => {
        expect(document.querySelector('.node-toolbar-overflow')).not.toBeNull();
      });
      const item = (
        <DropdownMenuItem onClick={command}>Test command</DropdownMenuItem>
      );
      render({
        overflow: nested ? (
          <DropdownMenuSubmenu label="Test submenu">{item}</DropdownMenuSubmenu>
        ) : (
          item
        ),
      });
      openPanel('toolbar.more');
      expect(mocks.ancestorClick).toHaveBeenCalled();
      mocks.ancestorClick.mockClear();
      if (nested) {
        const submenu = document.querySelector<HTMLButtonElement>(
          '.node-toolbar-overflow [aria-haspopup="menu"]',
        );
        if (!submenu) throw new Error('Missing submenu trigger');
        act(() => submenu.click());
        expect(submenu.getAttribute('aria-expanded')).toBe('true');
        expect(mocks.ancestorClick).not.toHaveBeenCalled();
      }
      const leaf = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((element) => element.textContent === 'Test command');
      if (!leaf) throw new Error('Missing overflow command');
      expect(container.contains(leaf)).toBe(false);
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail,
      });
      act(() => leaf.dispatchEvent(click));
      expect(command).toHaveBeenCalledOnce();
      expect(click.defaultPrevented).toBe(false);
      expect(document.querySelector('.node-toolbar-overflow')).toBeNull();
      expect(mocks.ancestorClick).not.toHaveBeenCalled();
    },
  );

  it('offers Question percentage scale and keeps font editing exclusive to Text', () => {
    render({
      type: 'question',
      data: { type: 'question', content: 'Question' },
    });
    expect(container.querySelector('[aria-label="Font size"]')).toBeNull();
    expect(container.querySelector('[name="question-card-scale"]')).toBeNull();
    openPanel('toolbar.size.title');
    const scaleInput = document.querySelector<HTMLInputElement>(
      '[name="question-card-scale"]',
    );
    expect(scaleInput?.min).toBe('10');
    expect(scaleInput?.max).toBe('1000');
    expect(scaleInput?.step).toBe('1');
    expect(
      document.querySelector<HTMLInputElement>('[name="question-card-scale"]')
        ?.value,
    ).toBe('100');
    const scaleLabel = document
      .querySelector('[name="question-card-scale"]')
      ?.closest('label');
    expect(scaleLabel?.textContent).toContain('toolbar.cardScale');
    expect(scaleLabel?.textContent).toContain('%');
    expect(
      container.querySelector('[aria-label="toolbar.resetCardScale"]'),
    ).toBeNull();
    expect(container.querySelector('.lucide-rotate-ccw')).toBeNull();
    render({ type: 'text', data: { type: 'text', content: 'Text' } });
    expect(container.querySelector('[name="question-card-scale"]')).toBeNull();
    expect(container.querySelector('[name="font-size"]')).not.toBeNull();
  });

  it('does not round stored fractional scales on focus/blur or Enter', () => {
    const fontSize = QUESTION_NODE_DEFAULT_FONT_SIZE * 1.23456789;
    mocks.canvas.nodes = [
      {
        id: 'node',
        type: 'question',
        position: { x: 0, y: 0 },
        style: { width: 400 },
        data: { style: { fontSize } },
      },
    ];
    render({
      type: 'question',
      data: { type: 'question', content: 'Question', style: { fontSize } },
    });
    openPanel('toolbar.size.title');
    const input = document.querySelector<HTMLInputElement>(
      '[name="question-card-scale"]',
    );
    if (!input) throw new Error('Missing card scale input');
    expect(input.value).toBe('123');
    act(() => {
      input.focus();
      input.blur();
    });
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(mocks.canvas.beginGesture).not.toHaveBeenCalled();
    expect(mocks.canvas.dispatchUiIntent).not.toHaveBeenCalled();
  });

  it.each([10, 100, 200, 1000])(
    'displays the resolved %s percent without changing its scale basis',
    (percent) => {
      const node = {
        id: 'node',
        type: 'question',
        position: { x: 0, y: 0 },
        style: { width: 400 },
        data: {
          type: 'question' as const,
          content: 'Question',
          style: { fontSize: QUESTION_NODE_DEFAULT_FONT_SIZE * 1.5 },
        },
      };
      const resolution = resolveSetQuestionCardScale(
        { type: 'SET_QUESTION_CARD_SCALE', nodeId: node.id, percent },
        { nodes: [node], edges: [] },
      );
      const command = resolution.commands[0];
      if (command?.type !== 'MERGE_NODE_DATA')
        throw new Error('Missing scale update');
      render({
        type: 'question',
        data: { ...node.data, ...command.patches[0].patch },
      });
      openPanel('toolbar.size.title');
      expect(
        document.querySelector<HTMLInputElement>('[name="question-card-scale"]')
          ?.value,
      ).toBe(String(percent));
    },
  );

  function pointer(button: HTMLButtonElement, type: string, x = 0) {
    act(() =>
      button.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          pointerType: 'mouse',
          clientX: x,
        }),
      ),
    );
  }

  it.each([
    ['video', 'film'],
    ['pdf', 'file-text'],
    ['web', 'globe'],
    ['image', 'image'],
    ['audio', 'mic'],
    ['office', 'file-type-corner'],
    ['frame', 'frame'],
    ['spacePreview', 'panels-top-left'],
    ['question', 'message-circle-question-mark'],
    ['sketch', 'pencil'],
  ] as const)(
    'uses the existing %s icon as the only leading control',
    (type, icon) => {
      render({ type });
      const button = handle();
      expect(button.getAttribute('aria-label')).toBe(`${type} · Drag to move`);
      expect(button.querySelector(`.lucide-${icon}`)).not.toBeNull();
      expect(container.querySelectorAll(`.lucide-${icon}`)).toHaveLength(1);
      expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
      expect(
        container.querySelectorAll('[data-node-drag-handle]'),
      ).toHaveLength(1);
      expect(
        container
          .querySelector('.node-floating-toolbar')
          ?.firstElementChild?.contains(button),
      ).toBe(true);
      expect(button.style.width).toBe('32px');
      expect(button.style.height).toBe('32px');
      expect(button.style.touchAction).toBe('none');
      expect(button.classList.contains('cursor-grab')).toBe(true);
      expect(button.hasAttribute('tabindex')).toBe(false);
      expect(button.disabled).toBe(false);
    },
  );

  it('uses a 32px button for non-mouse input', () => {
    mocks.isNotMouse = true;
    render();
    expect(handle().style.width).toBe('32px');
    expect(handle().style.height).toBe('32px');
  });

  it.each(['video', 'pdf', 'web', 'image'] as const)(
    'retains the plain %s indicator when dragging is not enabled',
    (type) => {
      render({ type, dragEnabled: false });
      expect(container.querySelector('[data-node-drag-handle]')).toBeNull();
      expect(container.querySelector('.text-fg-subtle svg')).not.toBeNull();
    },
  );

  it.each(['text', 'note'] as const)(
    'converts %s only through the overflow command',
    (type) => {
      render({ type });
      expect(
        container.querySelectorAll('[data-node-drag-handle]'),
      ).toHaveLength(1);
      const current = handle();
      act(() => current.click());
      expect(mocks.canvas.convertNodeType).not.toHaveBeenCalled();
      focus.mockClear();
      openPanel('toolbar.more');
      const alternate = document.querySelector<HTMLButtonElement>(
        '.node-toolbar-overflow [role="menuitem"]',
      );
      if (!alternate) throw new Error('Missing conversion command');
      act(() => alternate.click());
      expect(mocks.canvas.convertNodeType).toHaveBeenCalledExactlyOnceWith(
        'node',
        type === 'text' ? 'note' : 'text',
      );
      expect(mocks.canvas.onNodeDragStart).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it.each(['text', 'note'] as const)(
    'drags the current %s type without conversion',
    (type) => {
      render({ type });
      {
        const button = handle();
        pointer(button, 'pointerdown');
        pointer(button, 'pointermove', 20);
        pointer(button, 'pointerup', 20);
        const click = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        });
        act(() => button.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(true);
      }
      expect(mocks.canvas.onNodeDragStart).toHaveBeenCalledOnce();
      expect(mocks.canvas.onNodeDragStop).toHaveBeenCalledOnce();
      expect(mocks.canvas.convertNodeType).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it.each(['text', 'note'] as const)(
    'keeps current %s draggable but conversion disabled during preview or ingestion',
    (type) => {
      for (const reason of ['preview', 'ingestion']) {
        mocks.previewOpen = reason === 'preview';
        mocks.canvas.ingestionByNodeId =
          reason === 'ingestion' ? { node: { status: 'pending' } } : {};
        mocks.canvas.nodes[0].type = type;
        mocks.canvas.nodes[0].data = { type, content: 'Preserved content' };
        const before = structuredClone(mocks.canvas.nodes);
        render({ type });
        const current = handle();
        if (!document.querySelector('.node-toolbar-overflow'))
          openPanel('toolbar.more');
        const alternate = document.querySelector<HTMLButtonElement>(
          '.node-toolbar-overflow [role="menuitem"]',
        );
        if (!alternate) throw new Error('Missing conversion command');
        expect(current.disabled).toBe(false);
        expect(alternate.disabled).toBe(true);
        expect(alternate.hasAttribute('data-node-drag-handle')).toBe(false);
        pointer(current, 'pointerdown');
        pointer(current, 'pointerup');
        act(() => {
          current.click();
          alternate.click();
        });
        expect(document.activeElement).toBe(mocks.canvas.canvasWrapper);
        expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
        expect(mocks.canvas.nodes).toEqual(before);
        focus.mockClear();
        pointer(current, 'pointerdown');
        pointer(current, 'pointermove', 20);
        pointer(current, 'pointerup', 20);
        act(() => current.click());
        expect(focus).not.toHaveBeenCalled();
      }
      expect(mocks.canvas.convertNodeType).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodeDragStop).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['pointercancel', 'lostpointercapture', 'Escape', 'blur', 'disable'])(
    'suppresses conversion after %s in pending and locked gestures',
    (reason) => {
      for (const locked of [false, true]) {
        render({ type: 'text' });
        const button = handle();
        pointer(button, 'pointerdown');
        if (locked) pointer(button, 'pointermove', 20);
        if (reason === 'Escape')
          act(() =>
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            ),
          );
        else if (reason === 'blur')
          act(() => window.dispatchEvent(new Event('blur')));
        else if (reason === 'disable')
          render({ type: 'text', dragEnabled: false });
        else pointer(button, reason);
        const click = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        });
        act(() => button.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(true);
        expect(mocks.active).toHaveBeenLastCalledWith(false);
      }
      expect(mocks.canvas.convertNodeType).not.toHaveBeenCalled();
      expect(mocks.canvas.cancelActiveNodeDrag).toHaveBeenCalledOnce();
      expect(mocks.canvas.onNodeDragStop).not.toHaveBeenCalled();
    },
  );

  it.each(['locked', 'draggable', 'selection', 'interactivity'])(
    'respects the shared hook %s eligibility gate',
    (gate) => {
      if (gate === 'locked') mocks.canvas.nodes[0].data.locked = true;
      if (gate === 'draggable') mocks.canvas.nodes[0].draggable = false;
      if (gate === 'selection')
        mocks.canvas.nodes.push({
          id: 'other',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        });
      if (gate === 'interactivity') mocks.connectable = false;
      render();
      const button = handle();
      pointer(button, 'pointerdown');
      pointer(button, 'pointermove', 20);
      pointer(button, 'pointerup', 20);
      expect(mocks.active).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodeDragStart).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['video', 'pointer'],
    ['video', 'keyboard'],
    ['text', 'pointer'],
    ['text', 'keyboard'],
    ['note', 'pointer'],
    ['note', 'keyboard'],
  ] as const)(
    'focuses the canvas without changing the current %s on %s activation',
    (type, source) => {
      mocks.canvas.nodes[0].type = type;
      mocks.canvas.nodes[0].data = { type, content: 'Preserved content' };
      render({ type });
      const button = handle();
      const nodes = mocks.canvas.nodes;
      const before = structuredClone(nodes);
      act(() => button.focus());
      expect(document.activeElement).toBe(button);
      if (source === 'pointer') {
        pointer(button, 'pointerdown');
        pointer(button, 'pointerup');
      }
      // Native buttons synthesize a detail=0 click for Enter/Space activation.
      act(() =>
        button.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            detail: source === 'keyboard' ? 0 : 1,
          }),
        ),
      );
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(mocks.canvas.canvasWrapper);
      expect(mocks.canvas.nodes).toBe(nodes);
      expect(nodes).toEqual(before);
      expect(nodes[0].selected).toBe(true);
      expect(mocks.canvas.convertNodeType).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodeDragStart).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodeDrag).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodeDragStop).not.toHaveBeenCalled();
      expect(mocks.canvas.onNodesChange).not.toHaveBeenCalled();
    },
  );

  it('keeps the active button mounted across modifier changes and suppresses the trailing drag click', () => {
    render();
    const button = handle();
    pointer(button, 'pointerdown');
    expect(mocks.active).toHaveBeenLastCalledWith(true);
    mocks.modifierHeld = true;
    render({ dragActive: true });
    expect(container.querySelector('[data-node-drag-handle]')).toBe(button);
    pointer(button, 'pointermove', 20);
    pointer(button, 'pointerup', 20);
    expect(mocks.canvas.onNodeDragStart).toHaveBeenCalledOnce();
    expect(mocks.canvas.onNodeDragStop).toHaveBeenCalledOnce();
    expect(mocks.active).toHaveBeenLastCalledWith(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => button.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it('cancels an in-flight drag when the existing gate disables the control', () => {
    render();
    const button = handle();
    pointer(button, 'pointerdown');
    pointer(button, 'pointermove', 20);
    render({ dragEnabled: false });
    expect(container.querySelector('[data-node-drag-handle]')).toBeNull();
    expect(mocks.canvas.cancelActiveNodeDrag).toHaveBeenCalledOnce();
    expect(mocks.active).toHaveBeenLastCalledWith(false);
    expect(button.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
