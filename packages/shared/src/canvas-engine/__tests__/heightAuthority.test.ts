// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { nodeRevisionOf } from '../change.js';
import { HEIGHT_LAYOUT_VERSION } from '../height/freshness.js';
import { executeCanvasCommands } from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode, CanvasEdge } from '../interfaces.js';

const CONTENT = '# hello';
const KEY = `${HEIGHT_LAYOUT_VERSION}:${nodeRevisionOf({ content: CONTENT })}`;

function note(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    style: { width: 400 },
    data: { type: 'note', content: CONTENT },
    ...overrides,
  } as CanvasNode;
}

function run(commands: CanvasCommand[], nodes: CanvasNode[]) {
  return executeCanvasCommands(
    { source: 'ui', commands },
    { nodes, edges: [] as CanvasEdge[], canvasId: 'c1' },
  );
}

function styleOf(nodes: CanvasNode[], id: string) {
  return nodes.find((n) => n.id === id)?.style as
    | { width?: number; height?: number }
    | undefined;
}

function dataOf(nodes: CanvasNode[], id: string) {
  return nodes.find((n) => n.id === id)?.data as Record<string, unknown>;
}

describe("SET_NODE_GEOMETRY height: 'auto'", () => {
  it('materializes a numeric height instead of clearing it', () => {
    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            { nodeId: 'n1' as never, size: { width: 400, height: 'auto' } },
          ],
        },
      ],
      [
        note('n1', {
          style: { width: 400, height: 700 },
          data: {
            type: 'note',
            content: CONTENT,
            heightMode: 'fixed',
            autoHeight: { intrinsicHeight: 260, measuredFor: KEY },
          },
        } as Partial<CanvasNode>),
      ],
    );

    expect(styleOf(writeResult.nodes, 'n1')).toEqual({
      width: 400,
      height: 264,
    });
    expect(dataOf(writeResult.nodes, 'n1').heightMode).toBe('auto');
    // `getNodeSize` reads `measured` first, so the mirror must agree.
    expect(writeResult.nodes.find((n) => n.id === 'n1')?.measured?.height).toBe(
      264,
    );
  });

  it('falls back to a positive policy height when nothing has been measured', () => {
    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            { nodeId: 'n1' as never, size: { width: 400, height: 'auto' } },
          ],
        },
      ],
      [note('n1')],
    );

    expect(styleOf(writeResult.nodes, 'n1')?.height).toBeGreaterThan(0);
  });

  it('follows the new width, because note content scales with it', () => {
    const withHint = note('n1', {
      data: {
        type: 'note',
        content: CONTENT,
        heightMode: 'auto',
        autoHeight: { intrinsicHeight: 200, measuredFor: KEY },
      },
    } as Partial<CanvasNode>);

    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'n1' as never, size: { width: 800 } }],
        },
      ],
      [withHint],
    );

    expect(styleOf(writeResult.nodes, 'n1')).toEqual({
      width: 800,
      height: 404,
    });
  });

  it('records fixed ownership when a number is written', () => {
    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'n1' as never, size: { width: 400, height: 512 } }],
        },
      ],
      [note('n1', { data: { type: 'note', heightMode: 'auto' } })],
    );

    expect(styleOf(writeResult.nodes, 'n1')?.height).toBe(512);
    expect(dataOf(writeResult.nodes, 'n1').heightMode).toBe('fixed');
  });

  it('never records ownership on types that have no choice', () => {
    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            { nodeId: 'txt' as never, size: { width: 280, height: 140 } },
            { nodeId: 'img' as never, size: { width: 280, height: 140 } },
          ],
        },
      ],
      [
        note('txt', { type: 'text', data: { type: 'text' } }),
        note('img', { type: 'image', data: { type: 'image' } }),
      ],
    );

    expect(dataOf(writeResult.nodes, 'txt').heightMode).toBeUndefined();
    expect(dataOf(writeResult.nodes, 'img').heightMode).toBeUndefined();
  });
});

describe('APPLY_MEASURED_HEIGHT', () => {
  const measurement = {
    nodeId: 'n1' as never,
    intrinsicHeight: 260,
    measuredFor: KEY,
  };

  it('writes the hint and the geometry it implies together', () => {
    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      [
        note('n1', {
          data: { type: 'note', content: CONTENT, heightMode: 'auto' },
        }),
      ],
    );

    expect(styleOf(writeResult.nodes, 'n1')?.height).toBe(264);
    expect(writeResult.nodes.find((n) => n.id === 'n1')?.measured?.height).toBe(
      264,
    );
    expect(dataOf(writeResult.nodes, 'n1').autoHeight).toEqual({
      intrinsicHeight: 260,
      measuredFor: KEY,
    });
  });

  it('takes no undo snapshot — a measurement is not an action', () => {
    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      [note('n1')],
    );

    expect(writeResult.snapshotNeeded).toBe(false);
  });

  it('drops a measurement that lands after the user pinned the node', () => {
    // Nothing measured inside a box the user chose is a trustworthy
    // intrinsic height, and a wrong hint would be self-confirming.
    // `setNoteHeightMode` measures offscreen when it needs one.
    const pinned = note('n1', {
      style: { width: 400, height: 700 },
      data: { type: 'note', content: CONTENT, heightMode: 'fixed' },
    } as Partial<CanvasNode>);
    const start = [pinned];

    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      start,
    );

    expect(writeResult.nodes).toBe(start);
    expect(styleOf(writeResult.nodes, 'n1')?.height).toBe(700);
    expect(dataOf(writeResult.nodes, 'n1').autoHeight).toBeUndefined();
  });

  it('drops a measurement when the content changed while it was in flight', () => {
    const changedContent = '# changed while measuring';
    const current = note('n1', {
      style: { width: 400, height: 320 },
      data: {
        type: 'note',
        content: changedContent,
        heightMode: 'auto',
      },
    } as Partial<CanvasNode>);
    const start = [current];

    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      start,
    );

    expect(writeResult.nodes).toBe(start);
    expect(styleOf(writeResult.nodes, 'n1')?.height).toBe(320);
    expect(dataOf(writeResult.nodes, 'n1').autoHeight).toBeUndefined();
  });

  it('ignores a type that never auto-sizes', () => {
    const start = [note('n1', { type: 'image', data: { type: 'image' } })];
    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      start,
    );
    expect(writeResult.nodes).toBe(start);
  });

  it('lands the toggle and the measurement in one batch', () => {
    // What `setNoteHeightMode` emits for fixed → auto: the geometry
    // command hands ownership back and materializes the policy minimum,
    // then the measurement in the same batch takes it to the real
    // height — so the node never paints collapsed.
    const pinned = note('n1', {
      style: { width: 400, height: 700 },
      data: { type: 'note', content: CONTENT, heightMode: 'fixed' },
    } as Partial<CanvasNode>);

    const { writeResult } = run(
      [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            { nodeId: 'n1' as never, size: { width: 400, height: 'auto' } },
          ],
        },
        { type: 'APPLY_MEASURED_HEIGHT', items: [measurement] },
      ],
      [pinned],
    );

    expect(dataOf(writeResult.nodes, 'n1').heightMode).toBe('auto');
    expect(styleOf(writeResult.nodes, 'n1')?.height).toBe(264);
  });

  it('reuses node references for an unchanged re-measurement', () => {
    const start = [note('n1'), note('n2')];
    const first = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      start,
    ).writeResult.nodes as CanvasNode[];

    const second = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      first,
    ).writeResult;

    expect(second.nodes).toBe(first);
    expect(second.nodes[1]).toBe(first[1]);
  });

  it('refits the parent hug frame in the same batch', () => {
    const child = note('n1', {
      parentId: 'f1' as never,
      position: { x: 20, y: 20 },
    });
    const frame: CanvasNode = {
      id: 'f1',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 440, height: 120 },
      data: { type: 'frame', layoutMode: 'free' },
    } as CanvasNode;

    const { writeResult } = run(
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement] }],
      [frame, child],
    );

    const fitted = styleOf(writeResult.nodes, 'f1');
    expect(fitted?.height).toBeGreaterThan(260);
  });
});
