import { describe, expect, it } from 'vitest';

import { createStructuredReflowController } from '../structuredReflow';

import type { Node } from '@xyflow/react';

function node(id: string, x: number, y: number): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position: { x, y },
    data: {},
  } as Node;
}

function positions(nodes: Node[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((n) => [n.id, n.position]));
}

describe('structured reflow controller', () => {
  it('is a no-op before anything is applied', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    expect(controller.strip(nodes)).toBe(nodes);
    expect(controller.clear(nodes)).toBeNull();
  });

  it('moves peers to the projected positions', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    const next = controller.apply(nodes, [{ id: 'b', x: 0, y: 90 }]);

    expect(next).not.toBeNull();
    expect(positions(next!)).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 90 },
    });
    // Untouched nodes keep their identity so React can bail out.
    expect(next![0]).toBe(nodes[0]);
  });

  it('returns null when the projection changes nothing', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    expect(controller.apply(nodes, [{ id: 'b', x: 0, y: 40 }])).toBeNull();
  });

  it('strips back to the pre-drag geometry so ticks never compound', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    const tick1 = controller.apply(nodes, [{ id: 'b', x: 0, y: 90 }])!;
    // A later tick must be solved from the ORIGINAL geometry, not from
    // the previewed one — otherwise the preview feeds its own input.
    expect(positions(controller.strip(tick1))).toEqual(positions(nodes));

    const tick2 = controller.apply(tick1, [{ id: 'b', x: 0, y: 140 }])!;
    expect(positions(controller.strip(tick2))).toEqual(positions(nodes));
  });

  it('snaps peers back when they drop out of the projection', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    const moved = controller.apply(nodes, [
      { id: 'a', x: 0, y: 50 },
      { id: 'b', x: 0, y: 100 },
    ])!;
    const partial = controller.apply(moved, [{ id: 'a', x: 0, y: 50 }])!;

    expect(positions(partial)).toEqual({
      a: { x: 0, y: 50 },
      b: { x: 0, y: 40 },
    });
  });

  it('restores every displaced peer on clear', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40), node('c', 0, 80)];

    const moved = controller.apply(nodes, [
      { id: 'b', x: 0, y: 90 },
      { id: 'c', x: 0, y: 130 },
    ])!;
    const restored = controller.clear(moved)!;

    expect(positions(restored)).toEqual(positions(nodes));
    // Baseline is forgotten, so the next gesture starts clean.
    expect(controller.clear(restored)).toBeNull();
    expect(controller.strip(restored)).toBe(restored);
  });

  it('keeps the first-seen position as the baseline across ticks', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0), node('b', 0, 40)];

    let current = controller.apply(nodes, [{ id: 'b', x: 0, y: 90 }])!;
    current = controller.apply(current, [{ id: 'b', x: 0, y: 140 }])!;
    current = controller.apply(current, [{ id: 'b', x: 0, y: 200 }])!;

    expect(positions(controller.clear(current)!)).toEqual(positions(nodes));
  });

  it('ignores ids that are not in the nodes array', () => {
    const controller = createStructuredReflowController();
    const nodes = [node('a', 0, 0)];

    expect(controller.apply(nodes, [{ id: 'ghost', x: 9, y: 9 }])).toBeNull();
    expect(controller.clear(nodes)).toBeNull();
  });
});
