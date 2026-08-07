// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getStructuredFrameGutterPlan } from '@huabu/shared/canvas-engine';

import { getNodeFontFit, refitFont } from '@/utils/node/fontFit';
import {
  TEXT_NODE_PADDING_X,
  TEXT_NODE_PADDING_Y,
} from '@/utils/node/nodeFontConfig';

import { createSnapshot } from '../../../canvasHistoryManager';
import {
  createResizePreviewController,
  type ResizePreviewSliceState,
} from '../resizePreview';

import type { CanvasUiIntent } from '@/handler/canvasCommand/uiIntent';
import type { Edge, Node } from '@xyflow/react';

/**
 * Minimal in-memory store double for the resize-preview controller.
 *
 * Mirrors the real store's *immutable* update contract: `patchNodeSilent`
 * and `dispatchUiIntent` replace node objects (never mutate in place), so
 * a snapshot taken earlier keeps referencing the pre-edit node objects —
 * exactly the property the undo path relies on.
 */
function createStoreDouble(initialNodes: Node[], edges: Edge[] = []) {
  let nodes: Node[] = initialNodes;
  let lastResizeIntent: Extract<
    CanvasUiIntent,
    { type: 'RESIZE_NODE' }
  > | null = null;

  const patchNodeSilent = (nodeId: string, patch: Record<string, unknown>) => {
    nodes = nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n,
    );
  };

  // Apply RESIZE_NODE geometry the same way the real command pipeline
  // would: replace each affected node's style size + position. Enough for
  // the controller's `getNodeSize` reads to stay consistent across ticks.
  const dispatchUiIntent = (intent: CanvasUiIntent) => {
    if (intent.type !== 'RESIZE_NODE') return;
    lastResizeIntent = intent;
    nodes = nodes.map((n) => {
      const item = intent.items.find((i) => i.nodeId === n.id);
      if (!item) return n;
      return {
        ...n,
        position: item.position ?? n.position,
        style: {
          ...(n.style ?? {}),
          ...(item.size
            ? { width: item.size.width, height: item.size.height }
            : {}),
        },
      };
    });
  };

  const getState = (): ResizePreviewSliceState => ({
    nodes,
    edges,
    dispatchUiIntent,
    patchNodeSilent,
  });

  return {
    getState,
    getNodes: () => nodes,
    getLastResizeIntent: () => lastResizeIntent,
    setNodes: (next: Node[]) => {
      nodes = next;
    },
  };
}

describe('resize-preview controller — structured gutter freeze', () => {
  it('scales the captured gutter plan without recomputing it per tick', () => {
    const structuredFrame = {
      ...frameNode(),
      data: { layoutMode: 'column', gridCount: 2 },
    } as Node;
    const left = textNode('left', 16, 'left', {
      position: { x: 20, y: 20 },
      measured: { width: 60, height: 40 },
      data: { frameSlot: 0 },
    });
    const right = textNode('right', 16, 'right', {
      position: { x: 100, y: 20 },
      measured: { width: 60, height: 40 },
      data: { frameSlot: 1 },
    });
    const edge = {
      id: 'edge',
      source: 'left',
      target: 'right',
      data: { edgeStyle: { label: 'depends on' } },
    } as Edge;
    const nodes = [structuredFrame, left, right];
    const initialGutter = getStructuredFrameGutterPlan(
      nodes,
      [edge],
      'frame',
    )[0].finalSize;
    const store = createStoreDouble(nodes, [edge]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    controller.captureFrameResizeSnapshot('frame');
    controller.applyFrameResizeScale(392, 196, 0, 0);
    controller.flushFrameResizeScale();

    const frozen = store.getLastResizeIntent()?.frozenStructuredGutters;
    expect(frozen?.get('frame')?.x?.[0]).toBe(initialGutter * 2);
    controller.clearFrameResizeSnapshot();
  });
});

/** Locate a node by id, failing the test loudly if it is missing. */
function findNode(nodes: readonly Node[], id: string): Node {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`node "${id}" not found`);
  return found;
}

function textNode(
  id: string,
  fontSize: number,
  content = 'Hello world',
  extra?: Partial<Node>,
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position: { x: 10, y: 10 },
    style: { width: 40, height: 20 },
    data: { content, style: { fontSize, fontFamily: 'default' } },
    ...extra,
  } as Node;
}

/** The outer box the controller scaled a child to (read post-flush). */
function boxOf(node: Node): { width: number; height: number } {
  const s = node.style as { width: number; height: number };
  return { width: s.width, height: s.height };
}

const frameNode = (): Node =>
  ({
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    // 196×196 box. Children scale uniformly with the frame
    // (`sx = newW / frameW`, etc.) — padding is content-derived in the
    // production code and not exposed by the test surface, so the
    // assertions below check the controller's actual output rather than
    // hand-derived intermediates.
    style: { width: 196, height: 196 },
    data: { layoutMode: 'free' },
  }) as Node;

describe('resize-preview controller — child font refit', () => {
  it("re-derives a text child font from its new box (matching the node's own resize), and an undo snapshot restores it", () => {
    const node = textNode('text', 16);
    const store = createStoreDouble([frameNode(), node]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    // The fit the controller captures at gesture start — text + fontOpts +
    // inset. Computing expected with the SAME `refitFont` keeps the
    // assertion independent of pretext's absolute output in the test env.
    const fit = getNodeFontFit(node);
    expect(fit).not.toBeNull();

    // The undo snapshot the store takes at `onNodeResizeStart`, BEFORE any
    // scaling runs. `createSnapshot` keeps the original node objects.
    const undoSnapshot = createSnapshot(store.getNodes(), []);

    controller.captureFrameResizeSnapshot('frame');
    // Frame 196×196 → 396×396: content area 100×100 → 300×300, sx=sy=3.
    controller.applyFrameResizeScale(396, 396, 0, 0);
    controller.flushFrameResizeScale();

    const scaled = findNode(store.getNodes(), 'text');
    const box = boxOf(scaled);
    const expected = refitFont(fit!, box.width, box.height);
    expect(
      (scaled.data as { style: { fontSize: number } }).style.fontSize,
    ).toBe(expected);

    // Simulate undo: restore the pre-gesture snapshot.
    store.setNodes(undoSnapshot.nodes);
    const restored = findNode(store.getNodes(), 'text');
    expect(
      (restored.data as { style: { fontSize: number } }).style.fontSize,
    ).toBe(16);

    controller.clearFrameResizeSnapshot();
  });

  it('preserves sibling style fields and only overrides fontSize', () => {
    const child = textNode('text', 20, 'Some words here', {
      data: {
        content: 'Some words here',
        style: { fontSize: 20, fontFamily: 'serif', accent: 'blue' },
      },
    });
    const store = createStoreDouble([frameNode(), child]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });
    const fit = getNodeFontFit(child);
    expect(fit).toMatchObject({
      insetX: TEXT_NODE_PADDING_X,
      insetY: TEXT_NODE_PADDING_Y,
    });

    controller.captureFrameResizeSnapshot('frame');
    // Frame 196×196 → 146×146: uniform scale sx = sy = 146/196.
    controller.applyFrameResizeScale(146, 146, 0, 0);
    controller.flushFrameResizeScale();

    const scaled = findNode(store.getNodes(), 'text');
    const box = boxOf(scaled);
    const expected = refitFont(fit!, box.width, box.height);
    const style = (scaled.data as { style: Record<string, unknown> }).style;
    expect(style.fontSize).toBe(expected);
    expect(style.fontFamily).toBe('serif');
    expect(style.accent).toBe('blue');

    controller.clearFrameResizeSnapshot();
  });

  it('locks a refitted font onto an auto-sized child that had no fontSize yet', () => {
    // Most text nodes never get individually resized, so they carry no
    // `style.fontSize` and render at base 16. `setNodeGeometry` pins their
    // width during a frame cascade, so without a refit they would stay 16
    // in the enlarged box. The cascade must establish a locked fontSize.
    const node = {
      id: 'auto',
      type: 'text',
      parentId: 'frame',
      position: { x: 10, y: 10 },
      style: { width: 40, height: 20 },
      data: { content: 'Hello world', style: { fontFamily: 'default' } },
    } as Node;
    const store = createStoreDouble([frameNode(), node]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });
    const fit = getNodeFontFit(node);
    expect(fit).not.toBeNull();

    controller.captureFrameResizeSnapshot('frame');
    // Frame 196×196 → 396×396: uniform scale sx = sy = 396/196.
    controller.applyFrameResizeScale(396, 396, 0, 0);
    controller.flushFrameResizeScale();

    const scaled = findNode(store.getNodes(), 'auto');
    const box = boxOf(scaled);
    const expected = refitFont(fit!, box.width, box.height);
    const style = (scaled.data as { style: Record<string, unknown> }).style;
    expect(style.fontSize).toBe(expected);
    expect(style.fontFamily).toBe('default');

    controller.clearFrameResizeSnapshot();
  });

  it('leaves non-text children (no numeric fontSize) untouched', () => {
    const plain = {
      id: 'plain',
      type: 'web',
      parentId: 'frame',
      position: { x: 10, y: 40 },
      style: { width: 40, height: 20 },
      data: { url: 'https://example.com' },
    } as Node;
    const store = createStoreDouble([frameNode(), plain]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    controller.captureFrameResizeSnapshot('frame');
    controller.applyFrameResizeScale(296, 296, 0, 0);
    controller.flushFrameResizeScale();

    const after = findNode(store.getNodes(), 'plain');
    expect((after.data as { style?: unknown }).style).toBeUndefined();
    expect((after.data as { url: string }).url).toBe('https://example.com');

    controller.clearFrameResizeSnapshot();
  });

  it('refits an EMPTY text child to its placeholder, not to a single oversized line', () => {
    // Regression: `getNodeFontFit` used to measure the raw (empty) content,
    // so `computeFontSizeForHeight('', …)` returned `height/lineHeight` —
    // one giant line that overflows the box. An empty node must instead be
    // sized to fit its placeholder, exactly like the node's own resize.
    const node = {
      id: 'empty',
      type: 'text',
      parentId: 'frame',
      position: { x: 10, y: 10 },
      style: { width: 40, height: 20 },
      data: { content: '', style: { fontFamily: 'default' } },
    } as Node;
    const store = createStoreDouble([frameNode(), node]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });
    const fit = getNodeFontFit(node);
    expect(fit).not.toBeNull();
    // The fit carries the node's placeholder so the empty-text branch of
    // `refitFont` measures real glyphs.
    expect(fit!.text).toBe('');
    expect(fit!.placeholder.length).toBeGreaterThan(0);

    controller.captureFrameResizeSnapshot('frame');
    // Frame 196×196 → 396×396: uniform scale sx = sy = 396/196.
    controller.applyFrameResizeScale(396, 396, 0, 0);
    controller.flushFrameResizeScale();

    const scaled = findNode(store.getNodes(), 'empty');
    const box = boxOf(scaled);
    const expected = refitFont(fit!, box.width, box.height);
    const fontSize = (scaled.data as { style: { fontSize: number } }).style
      .fontSize;
    expect(fontSize).toBe(expected);
    // The placeholder is a multi-character string, so the fitted font must
    // be far smaller than the old "fill the height with one line" value.
    const oneLineFont =
      (box.height - fit!.insetY * 2) / fit!.fontOpts.lineHeight;
    expect(fontSize).toBeLessThan(oneLineFont);

    controller.clearFrameResizeSnapshot();
  });
});

describe('resize-preview controller — manual sizing skips child cascade', () => {
  it('does not scale or move children when the frame is sizing: manual', () => {
    // A manual frame owns its own box: resizing the frame must NOT drag
    // children with it. The child should keep its pre-gesture size and
    // position; the frame itself still updates.
    const manualFrame: Node = {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 200, height: 200 },
      data: { layoutMode: 'free', sizing: 'manual' },
    } as Node;
    const child = textNode('text', 16, 'pinned');
    const store = createStoreDouble([manualFrame, child]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    const before = findNode(store.getNodes(), 'text');
    const beforeBox = boxOf(before);
    const beforePos = { x: before.position.x, y: before.position.y };
    const beforeFont = (before.data as { style: { fontSize: number } }).style
      .fontSize;

    controller.captureFrameResizeSnapshot('frame');
    // BR-handle drag: frame origin (0, 0) unchanged, just grow to 400×400.
    controller.applyFrameResizeScale(400, 400, 0, 0);
    controller.flushFrameResizeScale();

    const after = findNode(store.getNodes(), 'text');
    expect(boxOf(after)).toEqual(beforeBox);
    expect(after.position).toEqual(beforePos);
    expect((after.data as { style: { fontSize: number } }).style.fontSize).toBe(
      beforeFont,
    );

    // The frame itself still receives its new geometry through the
    // gesture-tick dispatch.
    const frameAfter = findNode(store.getNodes(), 'frame');
    expect((frameAfter.style as { width: number; height: number }).width).toBe(
      400,
    );
    expect((frameAfter.style as { width: number; height: number }).height).toBe(
      400,
    );

    controller.clearFrameResizeSnapshot();
  });

  it("preserves the child's ABSOLUTE position when a manual frame's TL moves", () => {
    // TL/TR/BL/T/L-handle drags shift the frame's `(x, y)`. Children's
    // positions are stored local to the frame, so leaving the local
    // position unchanged would shift the absolute position by the same
    // delta — exactly what the cascade was hiding before. The fix:
    // compensate child local positions by the inverse of the frame
    // origin delta so each child stays put on screen.
    const manualFrame: Node = {
      id: 'frame',
      type: 'frame',
      position: { x: 100, y: 100 },
      style: { width: 200, height: 200 },
      data: { layoutMode: 'free', sizing: 'manual' },
    } as Node;
    const child = textNode('text', 16, 'pinned', {
      // Local (10, 10) → absolute (110, 110) at gesture start.
      position: { x: 10, y: 10 },
    });
    const store = createStoreDouble([manualFrame, child]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    const beforeChild = findNode(store.getNodes(), 'text');
    const beforeBox = boxOf(beforeChild);
    const beforeAbsX = 100 + beforeChild.position.x;
    const beforeAbsY = 100 + beforeChild.position.y;

    controller.captureFrameResizeSnapshot('frame');
    // TL-handle drag: shrink to 150×150 by moving the frame origin
    // from (100, 100) → (150, 150). BR stays at (300, 300).
    controller.applyFrameResizeScale(150, 150, 150, 150);
    controller.flushFrameResizeScale();

    const afterFrame = findNode(store.getNodes(), 'frame');
    expect(afterFrame.position).toEqual({ x: 150, y: 150 });

    const afterChild = findNode(store.getNodes(), 'text');
    // Child size pinned.
    expect(boxOf(afterChild)).toEqual(beforeBox);
    // Local position should be compensated by the frame origin delta
    // (50, 50), so child goes from (10, 10) → (-40, -40) — yielding the
    // same absolute (110, 110) as before. The child is now visually
    // OUTSIDE the shrunken frame's bounds, which is the expected manual
    // behaviour: the frame is just a box, the child does not follow.
    const afterAbsX = 150 + afterChild.position.x;
    const afterAbsY = 150 + afterChild.position.y;
    expect(afterAbsX).toBe(beforeAbsX);
    expect(afterAbsY).toBe(beforeAbsY);

    controller.clearFrameResizeSnapshot();
  });

  it('does not scale children when a structured (column) frame is sizing: manual', () => {
    // PR 2: `column|row + manual` is supported. The resize gesture
    // must behave the same as `free + manual` — children keep their
    // pre-gesture size and absolute position; only the frame's box
    // changes. The end-of-batch structured solver may still re-pack
    // children's local positions, but the controller itself must NOT
    // scale them.
    const structuredManual: Node = {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 200, height: 200 },
      data: { layoutMode: 'column', gridCount: 2, sizing: 'manual' },
    } as Node;
    const child = textNode('text', 16, 'pinned');
    const store = createStoreDouble([structuredManual, child]);
    const controller = createResizePreviewController({
      getState: store.getState,
    });

    const before = findNode(store.getNodes(), 'text');
    const beforeBox = boxOf(before);
    const beforeFont = (before.data as { style: { fontSize: number } }).style
      .fontSize;

    controller.captureFrameResizeSnapshot('frame');
    controller.applyFrameResizeScale(400, 400, 0, 0);
    controller.flushFrameResizeScale();

    const after = findNode(store.getNodes(), 'text');
    // Size pinned — no scaling cascade even though the layout is
    // structured.
    expect(boxOf(after)).toEqual(beforeBox);
    // Font untouched — no refit.
    expect((after.data as { style: { fontSize: number } }).style.fontSize).toBe(
      beforeFont,
    );

    const frameAfter = findNode(store.getNodes(), 'frame');
    expect((frameAfter.style as { width: number; height: number }).width).toBe(
      400,
    );

    controller.clearFrameResizeSnapshot();
  });
});
