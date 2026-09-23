// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NODE_CONTROL_CHROME,
  NODE_RESIZE_GRIP_STYLE,
} from '@/config/nodeInteractionChrome';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import {
  canSnapshotMultiSelectRoot,
  MultiSelectResizer,
  resolveMultiSelectGeometry,
  resolveMultiSelectScale,
} from './MultiSelectResizer';

import type { Node } from '@xyflow/react';
import type * as XYFlow from '@xyflow/react';

const harness = vi.hoisted(() => ({
  nodes: [] as Node[],
  domNode: null as HTMLDivElement | null,
  patchNodeSilent: vi.fn(),
  previewResizeGeometry: vi.fn(),
  setNodeGeometry: vi.fn(),
  onNodeResizeStart: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  default: (selector: (state: typeof harness) => unknown) => selector(harness),
}));
vi.mock('@/hooks/useInputMode.ts', () => ({ useIsNotMouse: () => false }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof XYFlow>()),
  useStore: (selector: (state: typeof harness) => unknown) => selector(harness),
  useViewport: () => ({ zoom: 1, x: 0, y: 0 }),
  useStoreApi: () => ({ getState: () => ({ transform: [0, 0, 1] }) }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function pointer(target: Element, type: string, init: PointerEventInit) {
  act(() =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })),
  );
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  harness.domNode?.remove();
  harness.domNode = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('MultiSelectResizer content scale gesture', () => {
  it.each([
    ['text', false],
    ['question', false],
    ['text', true],
    ['question', true],
  ] as const)(
    'uniformly scales %s with nested=%s and commits the last preview',
    (type, nested) => {
      const content: Node = {
        id: 'content',
        type,
        selected: !nested,
        position: { x: 0, y: 0 },
        style: { width: 200, height: 100 },
        data: {
          style: {
            accent: 'blue',
            ...(type === 'text' ? { fontSize: 17.375 } : {}),
          },
        },
        ...(nested ? { parentId: 'frame' } : {}),
      };
      harness.nodes = [
        ...(nested
          ? [
              {
                id: 'frame',
                type: 'frame',
                selected: true,
                position: { x: 0, y: 0 },
                style: { width: 200, height: 100 },
                data: { sizing: 'hug' },
              },
            ]
          : []),
        content,
        {
          id: 'other',
          type: 'web',
          selected: true,
          position: { x: 200, y: 100 },
          style: { width: 200, height: 100 },
          data: {},
        },
      ];
      harness.domNode = document.createElement('div');
      document.body.append(harness.domNode);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      act(() => root?.render(createElement(MultiSelectResizer)));
      const overlay = harness.domNode.querySelector<HTMLElement>(
        '[data-multi-selection]',
      );
      if (!overlay) throw new Error('Missing multi-selection overlay');
      expect(overlay.style.left).toBe('0px');
      expect(overlay.style.top).toBe('0px');
      expect(overlay.style.width).toBe('400px');
      expect(overlay.style.height).toBe('200px');
      expect(
        overlay.querySelector('[data-selection-outline="dashed"]'),
      ).not.toBeNull();
      const controls = overlay.querySelectorAll<HTMLElement>(
        '[data-multi-resize-control]',
      );
      expect(controls).toHaveLength(4);
      for (const control of controls) {
        expect(control.style.width).toBe(
          `${NODE_CONTROL_CHROME.hitSize.mouse}px`,
        );
        expect(control.style.height).toBe(
          `${NODE_CONTROL_CHROME.hitSize.mouse}px`,
        );
        const grip = control.querySelector<HTMLElement>('[data-resize-grip]');
        if (!grip) throw new Error('Missing shared resize grip');
        expect(grip.style.width).toBe(`${NODE_CONTROL_CHROME.size.mouse}px`);
        expect(grip.style.boxShadow).toBe(NODE_RESIZE_GRIP_STYLE.boxShadow);
      }
      const handle = harness.domNode.querySelectorAll(
        '.pointer-events-auto',
      )[3];
      pointer(handle, 'pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
      });
      const base = type === 'text' ? 17.375 : QUESTION_NODE_DEFAULT_FONT_SIZE;
      for (const [x, y, scale] of [
        [600, 200, 1.4],
        [200, 100, 0.5],
        [400, 200, 1],
      ]) {
        pointer(handle, 'pointermove', {
          pointerId: 1,
          clientX: x,
          clientY: y,
        });
        const items = harness.previewResizeGeometry.mock.lastCall?.[0];
        expect(items).toBeDefined();
        expect(
          items.find((item: { nodeId: string }) => item.nodeId === 'content')
            .size,
        ).toEqual({ width: 200 * scale, height: 100 * scale });
        expect(harness.patchNodeSilent).toHaveBeenLastCalledWith('content', {
          style: {
            ...(content.data.style as object),
            fontSize: (base * (200 * scale)) / 200,
          },
        });
      }
      pointer(handle, 'pointerup', { pointerId: 1 });
      expect(harness.onNodeResizeStart).toHaveBeenCalledTimes(1);
      expect(harness.setNodeGeometry).toHaveBeenCalledWith(
        harness.previewResizeGeometry.mock.lastCall?.[0],
      );
      expect(harness.patchNodeSilent).toHaveBeenCalledTimes(3);
    },
  );
});

describe('MultiSelectResizer Frame selection visibility', () => {
  it.each([false, true])(
    'keeps the union and scales a selected Frame subtree once with overflow=%s',
    (overflow) => {
      harness.nodes = [
        {
          id: 'frame',
          type: 'frame',
          selected: true,
          position: { x: 100, y: 80 },
          style: { width: 400, height: 300 },
          data: {},
        },
        {
          id: 'child',
          type: 'web',
          selected: true,
          parentId: 'frame',
          position: { x: overflow ? 360 : 40, y: 60 },
          style: { width: 80, height: 70 },
          data: {},
        },
        {
          id: 'sibling',
          type: 'web',
          selected: false,
          parentId: 'frame',
          position: { x: 140, y: 100 },
          style: { width: 80, height: 70 },
          data: {},
        },
      ];
      harness.domNode = document.createElement('div');
      document.body.append(harness.domNode);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      act(() => root?.render(createElement(MultiSelectResizer)));
      const overlay = harness.domNode.querySelector<HTMLElement>(
        '[data-multi-selection]',
      );
      if (!overlay)
        throw new Error('Frame plus child must retain multi-selection chrome');
      expect(overlay.style.left).toBe('100px');
      expect(overlay.style.top).toBe('80px');
      expect(overlay.style.width).toBe(overflow ? '440px' : '400px');
      expect(overlay.style.height).toBe('300px');
      expect(
        overlay.querySelectorAll('[data-multi-resize-control]'),
      ).toHaveLength(4);
      const handle = overlay.querySelector('[data-multi-resize-control="br"]');
      if (!handle) throw new Error('Missing group resize handle');
      pointer(handle, 'pointerdown', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
      });
      pointer(handle, 'pointermove', {
        pointerId: 1,
        clientX: 100 + (overflow ? 440 : 400) * 2,
        clientY: 680,
      });
      pointer(handle, 'pointerup', { pointerId: 1 });
      expect(harness.onNodeResizeStart).toHaveBeenCalledTimes(1);
      expect(harness.setNodeGeometry).toHaveBeenCalledTimes(1);
      const items = harness.setNodeGeometry.mock.lastCall?.[0];
      expect(items).toHaveLength(3);
      expect(items).toEqual([
        {
          nodeId: 'frame',
          position: { x: 100, y: 80 },
          size: { width: 800, height: 600 },
        },
        {
          nodeId: 'child',
          position: { x: overflow ? 720 : 80, y: 120 },
          size: { width: 160, height: 140 },
        },
        {
          nodeId: 'sibling',
          position: { x: 280, y: 200 },
          size: { width: 160, height: 140 },
        },
      ]);
      harness.nodes = harness.nodes.map((node) => ({
        ...node,
        selected: node.id === 'frame',
      }));
      act(() => root?.render(createElement(MultiSelectResizer)));
      expect(
        harness.domNode.querySelector('[data-multi-selection]'),
      ).toBeNull();
    },
  );
});

describe('canSnapshotMultiSelectRoot', () => {
  it('excludes a locked selected root from resize geometry', () => {
    expect(canSnapshotMultiSelectRoot({ data: { locked: true } })).toBe(false);
    expect(canSnapshotMultiSelectRoot({ data: {} })).toBe(true);
  });
});

describe('resolveMultiSelectScale', () => {
  it('keeps free-axis scaling for selections without locked media', () => {
    expect(
      resolveMultiSelectScale({
        offX: 200,
        offY: 50,
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        uniform: false,
      }),
    ).toEqual({ scaleX: 2, scaleY: 0.5 });
  });

  it('uses one scale when the selection contains aspect-locked media', () => {
    const scale = resolveMultiSelectScale({
      offX: 200,
      offY: 50,
      diag: { x: 100, y: 100 },
      diagLen2: 20_000,
      uniform: true,
    });

    expect(scale.scaleX).toBe(scale.scaleY);
    expect(scale).toEqual({ scaleX: 1.25, scaleY: 1.25 });
  });
});

describe('resolveMultiSelectGeometry', () => {
  it('scales a selected Frame and its child in the same coordinate space', () => {
    const items = resolveMultiSelectGeometry({
      snapshot: {
        anchor: { x: 0, y: 0 },
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        nodes: [
          {
            id: 'frame',
            scaleRootId: 'frame',
            parentAbs: { x: 0, y: 0 },
            pos0Abs: { x: 100, y: 100 },
            size0: { width: 200, height: 200 },
            preserveAspectRatio: false,
          },
          {
            id: 'child',
            parentId: 'frame',
            scaleRootId: 'frame',
            parentAbs: { x: 100, y: 100 },
            pos0Abs: { x: 150, y: 160 },
            size0: { width: 80, height: 60 },
            preserveAspectRatio: false,
          },
        ],
      },
      scaleX: 0.5,
      scaleY: 0.5,
    });

    expect(items).toEqual([
      {
        nodeId: 'frame',
        position: { x: 50, y: 50 },
        size: { width: 100, height: 100 },
      },
      {
        nodeId: 'child',
        position: { x: 25, y: 30 },
        size: { width: 40, height: 30 },
      },
    ]);
  });

  it('scales nested Frames once relative to the outer scaling root', () => {
    const items = resolveMultiSelectGeometry({
      snapshot: {
        anchor: { x: 0, y: 0 },
        diag: { x: 100, y: 100 },
        diagLen2: 20_000,
        nodes: [
          {
            id: 'outer',
            scaleRootId: 'outer',
            parentAbs: { x: 0, y: 0 },
            pos0Abs: { x: 100, y: 100 },
            size0: { width: 200, height: 200 },
            preserveAspectRatio: false,
          },
          {
            id: 'inner',
            parentId: 'outer',
            scaleRootId: 'outer',
            parentAbs: { x: 100, y: 100 },
            pos0Abs: { x: 140, y: 140 },
            size0: { width: 100, height: 100 },
            preserveAspectRatio: false,
          },
          {
            id: 'child',
            parentId: 'inner',
            scaleRootId: 'outer',
            parentAbs: { x: 140, y: 140 },
            pos0Abs: { x: 160, y: 160 },
            size0: { width: 20, height: 20 },
            preserveAspectRatio: false,
          },
        ],
      },
      scaleX: 0.5,
      scaleY: 0.5,
    });

    expect(items).toEqual([
      {
        nodeId: 'outer',
        position: { x: 50, y: 50 },
        size: { width: 100, height: 100 },
      },
      {
        nodeId: 'inner',
        position: { x: 20, y: 20 },
        size: { width: 50, height: 50 },
      },
      {
        nodeId: 'child',
        position: { x: 10, y: 10 },
        size: { width: 10, height: 10 },
      },
    ]);
  });
});
