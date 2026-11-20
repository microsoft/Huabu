// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands, measuredSizeKey } from '../index.js';

import type {
  CanvasCommand,
  CanvasExecutionSource,
} from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

function text(id: string, extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id,
    type: 'text',
    position: { x: 20, y: 60 },
    style: { width: 200 },
    data: { type: 'text', content: 'hello' },
    ...extra,
  } as CanvasNode;
}

function hugFrame(id: string): CanvasNode {
  return {
    id,
    type: 'frame',
    position: { x: 0, y: 0 },
    style: { width: 300, height: 200 },
    data: { type: 'frame', sizing: 'hug' },
  } as CanvasNode;
}

function report(
  nodes: CanvasNode[],
  items: Array<Record<string, unknown>>,
  source: CanvasExecutionSource = 'ui',
) {
  return executeCanvasCommands(
    {
      source,
      commands: [
        { type: 'APPLY_MEASURED_SIZE', items } as unknown as CanvasCommand,
      ],
    },
    { nodes, edges: [], canvasId: 'c1' },
  );
}

describe('APPLY_MEASURED_SIZE', () => {
  it('records the box and mirrors it to measured', () => {
    const node = text('t');
    const key = measuredSizeKey(node);
    const { commandResults, writeResult } = report(
      [node],
      [{ nodeId: 't', width: 200, height: 84, measuredFor: key }],
    );
    expect(commandResults[0].applied).toBe(true);
    expect(writeResult.nodes[0]).toMatchObject({
      measured: { width: 200, height: 84 },
      data: { measuredSize: { width: 200, height: 84, measuredFor: key } },
    });
    // The node has no authored height and gains none.
    expect(writeResult.nodes[0].style).toEqual({ width: 200 });
    expect(writeResult.snapshotNeeded).toBe(false);
  });

  it('refits the Frame around the reported box', () => {
    const frame = hugFrame('f');
    const small = text('t', {
      parentId: 'f',
      measured: { width: 200, height: 40 },
    });
    const before = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'APPLY_MEASURED_SIZE',
            items: [
              {
                nodeId: 't',
                width: 200,
                height: 40,
                measuredFor: measuredSizeKey(small),
              },
            ],
          } as unknown as CanvasCommand,
        ],
      },
      { nodes: [frame, small], edges: [], canvasId: 'c1' },
    ).writeResult.nodes;
    const fittedHeight = (before[0].style as { height: number }).height;

    const { writeResult } = report(before, [
      {
        nodeId: 't',
        width: 200,
        height: 240,
        measuredFor: measuredSizeKey(small),
      },
    ]);
    expect((writeResult.nodes[0].style as { height: number }).height).toBe(
      fittedHeight + 200,
    );
  });

  it('ignores a measurement taken before the content changed', () => {
    const stale = measuredSizeKey(text('t'));
    const node = text('t', { data: { type: 'text', content: 'changed' } });
    const nodes = [node];
    const { commandResults, writeResult } = report(nodes, [
      { nodeId: 't', width: 200, height: 84, measuredFor: stale },
    ]);
    expect(commandResults[0]).toMatchObject({
      applied: false,
      reason: 'no-op',
    });
    expect(writeResult.nodes).toBe(nodes);
  });

  it('ignores a measurement taken at another authored width', () => {
    const stale = measuredSizeKey(text('t'));
    const { commandResults } = report(
      [text('t', { style: { width: 320 } })],
      [{ nodeId: 't', width: 200, height: 84, measuredFor: stale }],
    );
    expect(commandResults[0].applied).toBe(false);
  });

  it('is a no-op when the same box is already recorded', () => {
    const node = text('t');
    const item = {
      nodeId: 't',
      width: 200,
      height: 84,
      measuredFor: measuredSizeKey(node),
    };
    const first = report([node], [item]).writeResult.nodes;
    const again = report(first, [item]);
    expect(again.commandResults[0]).toMatchObject({
      applied: false,
      reason: 'no-op',
    });
    expect(again.writeResult.nodes).toBe(first);
  });

  it('ignores types whose size is authored, and malformed boxes', () => {
    const note = {
      id: 'n',
      type: 'note',
      position: { x: 0, y: 0 },
      style: { width: 200, height: 100 },
      data: { type: 'note', content: 'x' },
    } as CanvasNode;
    expect(
      report(
        [note],
        [
          {
            nodeId: 'n',
            width: 200,
            height: 80,
            measuredFor: measuredSizeKey(note),
          },
        ],
      ).commandResults[0].applied,
    ).toBe(false);
    const node = text('t');
    expect(
      report(
        [node],
        [
          {
            nodeId: 't',
            width: 0,
            height: Number.NaN,
            measuredFor: measuredSizeKey(node),
          },
        ],
      ).commandResults[0].applied,
    ).toBe(false);
  });

  it('is refused for an agent batch', () => {
    const node = text('t');
    expect(
      report(
        [node],
        [
          {
            nodeId: 't',
            width: 200,
            height: 84,
            measuredFor: measuredSizeKey(node),
          },
        ],
        'agent',
      ).commandResults[0],
    ).toMatchObject({ applied: false, reason: 'invalid-scope' });
  });
});
