// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  applyStructuredFrameRelayout,
  executeCanvasCommands,
  fitFrameToChildren,
  getAbsolutePosition,
  getNodeSize,
} from '@huabu/shared/canvas-engine';

import { createResizePreviewController } from '../resizePreview';

import type { CanvasUiIntent } from '@/handler/canvasCommand/uiIntent';
import type { CanvasNodeId } from '@huabu/shared';
import type { Node } from '@xyflow/react';

type Layout = 'free' | 'column' | 'row' | 'grid';
const frameIds = ['outer', 'middle', 'inner'] as const;

function fixture(modes: readonly Layout[]): Node[] {
  let nodes: Node[] = frameIds.map((id, index) => ({
    id,
    type: 'frame',
    parentId: index ? frameIds[index - 1] : undefined,
    position: index ? { x: 20, y: 64 } : { x: 100, y: 100 },
    style: { width: 600, height: 600 },
    data: { layoutMode: modes[index], sizing: 'hug', gridCount: 1 },
  }));
  nodes.push({
    id: 'leaf',
    type: 'note',
    parentId: 'inner',
    position: { x: 20, y: 64 },
    style: { width: 240, height: 160 },
    data: { content: 'Fixed-height content', heightMode: 'fixed' },
  });
  for (const id of [...frameIds].reverse()) {
    nodes = applyStructuredFrameRelayout(nodes, [id]).nodes;
    nodes = fitFrameToChildren(nodes, id);
  }
  return nodes;
}

function harness(initial: Node[]) {
  let nodes = initial;
  const dispatch = vi.fn((intent: CanvasUiIntent) => {
    if (intent.type !== 'RESIZE_NODE') return;
    nodes = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: intent.items.map((item) => ({
              ...item,
              nodeId: item.nodeId as CanvasNodeId,
            })),
          },
        ],
      },
      { nodes, edges: [], canvasId: 'nested-resize-test' },
      { frozenStructuredGutters: intent.frozenStructuredGutters },
    ).writeResult.nodes;
  });
  const controller = createResizePreviewController({
    getState: () => ({
      nodes,
      edges: [],
      dispatchUiIntent: dispatch,
      patchNodeSilent: (id, patch) => {
        nodes = nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
        );
      },
    }),
  });
  return { controller, dispatch, nodes: () => nodes };
}

function node(nodes: Node[], id: string) {
  const found = nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

function expectContained(nodes: Node[]) {
  for (const child of nodes) {
    if (!child.parentId) continue;
    const parentSize = getNodeSize(node(nodes, child.parentId));
    const childSize = getNodeSize(child);
    expect(child.position.x).toBeGreaterThanOrEqual(-0.000001);
    expect(child.position.y).toBeGreaterThanOrEqual(-0.000001);
    expect(child.position.x + childSize.width).toBeLessThanOrEqual(
      parentSize.width + 0.000001,
    );
    expect(child.position.y + childSize.height).toBeLessThanOrEqual(
      parentSize.height + 0.000001,
    );
  }
}

function absolute(nodes: Node[], id: string) {
  const position = getAbsolutePosition(nodes, id);
  if (!position) throw new Error(`Missing absolute position for ${id}`);
  return position;
}

describe('three nested Frames through the real geometry executor', () => {
  it.each(['text', 'question'])(
    'scales deeply nested %s fonts from the immutable width baseline',
    (type) => {
      const initial = fixture(['free', 'free', 'free']).map((n) =>
        n.id === 'leaf'
          ? {
              ...n,
              type,
              data: {
                content: 'Nested content',
                label: 'Nested content',
                style: { fontSize: 24 },
              },
            }
          : n,
      );
      const h = harness(initial);
      const root = getNodeSize(initial[0]);
      h.controller.captureFrameResizeSnapshot('outer');
      for (const factor of [2, 0.8, 1]) {
        h.controller.applyFrameResizeScale(
          root.width * factor,
          root.height * factor,
          initial[0].position.x,
          initial[0].position.y,
        );
        h.controller.flushFrameResizeScale();
        const leaf = node(h.nodes(), 'leaf');
        expect(getNodeSize(leaf).width).toBeCloseTo(240 * factor, 6);
        expect((leaf.data.style as { fontSize: number }).fontSize).toBeCloseTo(
          24 * factor,
          10,
        );
        expect(leaf.style?.height).toBeUndefined();
      }
      h.controller.clearFrameResizeSnapshot();
    },
  );

  for (const modes of [
    ['free', 'free', 'free'],
    ['free', 'column', 'grid'],
    ['column', 'free', 'row'],
    ['grid', 'row', 'column'],
  ] as const) {
    it.each(frameIds)(
      `${modes.join('/')} resizing %s scales descendants and fits ancestors without drift`,
      (id) => {
        const initial = fixture(modes);
        const h = harness(initial);
        const start = node(initial, id);
        const startSize = getNodeSize(start);
        const initialLeaf = getNodeSize(node(initial, 'leaf'));
        h.controller.captureFrameResizeSnapshot(id);
        for (const factor of [1.5, 0.8, 1.5, 1]) {
          const target = {
            width: startSize.width * factor,
            height: startSize.height * factor,
          };
          h.controller.applyFrameResizeScale(
            target.width,
            target.height,
            start.position.x,
            start.position.y,
          );
          h.controller.flushFrameResizeScale();
          const resized = getNodeSize(node(h.nodes(), id));
          expect(resized.width).toBeCloseTo(target.width, 6);
          expect(resized.height).toBeCloseTo(target.height, 6);
          const leaf = getNodeSize(node(h.nodes(), 'leaf'));
          if (factor > 1) {
            expect(leaf.width).toBeGreaterThan(initialLeaf.width);
            expect(leaf.height).toBeGreaterThan(initialLeaf.height);
          } else if (factor < 1) {
            expect(leaf.width).toBeLessThan(initialLeaf.width);
            expect(leaf.height).toBeLessThan(initialLeaf.height);
          }
          expectContained(h.nodes());
          // Every ancestor and descendant changes size in the same direction.
          for (const frameId of frameIds) {
            const before = getNodeSize(node(initial, frameId));
            const after = getNodeSize(node(h.nodes(), frameId));
            expect(Math.sign(after.width - before.width)).toBe(
              factor === 1 ? 0 : Math.sign(factor - 1),
            );
            expect(Math.sign(after.height - before.height)).toBe(
              factor === 1 ? 0 : Math.sign(factor - 1),
            );
          }
          if (id === 'outer')
            expect(node(h.nodes(), id).position).toEqual(start.position);
        }
        h.controller.clearFrameResizeSnapshot();
        const preview = h.nodes();
        h.dispatch({
          type: 'RESIZE_NODE',
          items: [{ nodeId: id, size: startSize }],
        });
        for (const before of initial) {
          const after = node(h.nodes(), before.id);
          expect(getNodeSize(after).width).toBeCloseTo(
            getNodeSize(before).width,
            6,
          );
          expect(getNodeSize(after).height).toBeCloseTo(
            getNodeSize(before).height,
            6,
          );
          expect(getAbsolutePosition(h.nodes(), before.id)).toEqual(
            getAbsolutePosition(preview, before.id),
          );
        }
      },
    );
  }

  it.each(frameIds)(
    'moving the top-left of free %s preserves the opposite corner in canvas space',
    (id) => {
      const initial = fixture(['free', 'free', 'free']);
      const h = harness(initial);
      const start = node(initial, id);
      const size = getNodeSize(start);
      const abs = absolute(initial, id);
      h.controller.captureFrameResizeSnapshot(id);
      h.controller.applyFrameResizeScale(
        size.width * 1.5,
        size.height * 1.5,
        start.position.x - size.width * 0.5,
        start.position.y - size.height * 0.5,
      );
      h.controller.flushFrameResizeScale();
      const after = absolute(h.nodes(), id);
      const next = getNodeSize(node(h.nodes(), id));
      expect(after.x + next.width).toBeCloseTo(abs.x + size.width, 6);
      expect(after.y + next.height).toBeCloseTo(abs.y + size.height, 6);
      expectContained(h.nodes());
      h.controller.clearFrameResizeSnapshot();
    },
  );

  it.each(frameIds)(
    'Manual %s changes only its box and leaves descendants fixed',
    (id) => {
      const initial = fixture(['free', 'free', 'free']).map((n) =>
        n.id === id ? { ...n, data: { ...n.data, sizing: 'manual' } } : n,
      );
      const h = harness(initial);
      const start = node(initial, id);
      const size = getNodeSize(start);
      const descendants = initial.slice(
        initial.findIndex((n) => n.id === id) + 1,
      );
      h.controller.captureFrameResizeSnapshot(id);
      for (const factor of [1.5, 0.8, 1]) {
        h.controller.applyFrameResizeScale(
          size.width * factor,
          size.height * factor,
          start.position.x,
          start.position.y,
        );
        h.controller.flushFrameResizeScale();
        expect(getNodeSize(node(h.nodes(), id))).toEqual({
          width: size.width * factor,
          height: size.height * factor,
        });
        for (const child of descendants) {
          expect(getNodeSize(node(h.nodes(), child.id))).toEqual(
            getNodeSize(child),
          );
          expect(getAbsolutePosition(h.nodes(), child.id)).toEqual(
            getAbsolutePosition(initial, child.id),
          );
        }
      }
      h.controller.clearFrameResizeSnapshot();
    },
  );

  it('a resized inner Frame cannot resize a Manual outer ancestor through a Hug middle Frame', () => {
    const initial = fixture(['free', 'free', 'free']).map((n) =>
      n.id === 'outer' ? { ...n, data: { ...n.data, sizing: 'manual' } } : n,
    );
    const h = harness(initial);
    const start = node(initial, 'inner');
    const size = getNodeSize(start);
    h.controller.captureFrameResizeSnapshot('inner');
    h.controller.applyFrameResizeScale(
      size.width * 2,
      size.height * 2,
      start.position.x,
      start.position.y,
    );
    h.controller.flushFrameResizeScale();
    expect(getNodeSize(node(h.nodes(), 'outer'))).toEqual(
      getNodeSize(initial[0]),
    );
    expect(node(h.nodes(), 'outer').position).toEqual(initial[0].position);
    expect(getNodeSize(node(h.nodes(), 'middle')).width).toBeGreaterThan(
      getNodeSize(initial[1]).width,
    );
    h.controller.clearFrameResizeSnapshot();
  });

  it('repeated top-left previews use the original canvas-space anchor after ancestor fitting', () => {
    const initial = fixture(['free', 'free', 'free']);
    const h = harness(initial);
    const start = node(initial, 'inner');
    const size = getNodeSize(start);
    const abs = absolute(initial, 'inner');
    h.controller.captureFrameResizeSnapshot('inner');
    for (const factor of [1.5, 0.8, 1.5, 1]) {
      h.controller.applyFrameResizeScale(
        size.width * factor,
        size.height * factor,
        start.position.x + size.width * (1 - factor),
        start.position.y + size.height * (1 - factor),
      );
      h.controller.flushFrameResizeScale();
      const after = absolute(h.nodes(), 'inner');
      expect(after.x + getNodeSize(node(h.nodes(), 'inner')).width).toBeCloseTo(
        abs.x + size.width,
        6,
      );
      expect(
        after.y + getNodeSize(node(h.nodes(), 'inner')).height,
      ).toBeCloseTo(abs.y + size.height, 6);
    }
    h.controller.clearFrameResizeSnapshot();
  });
});
