// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { CanvasHistoryRegistry } from './canvasHistoryManager';

import type { Node } from '@xyflow/react';

function node(id: string, x: number): Node {
  return {
    id,
    type: 'note',
    position: { x, y: 0 },
    data: {},
  };
}

describe('CanvasHistoryRegistry', () => {
  it('restores independent undo stacks when switching Canvas scopes', () => {
    const history = new CanvasHistoryRegistry();

    history.activate('canvas-world');
    history.takeSnapshot([node('world-note', 0)], []);
    expect(history.canUndo).toBe(true);

    history.activate('canvas-space');
    expect(history.canUndo).toBe(false);
    history.takeSnapshot([node('space-note', 10)], []);

    history.activate('canvas-world');
    expect(history.canUndo).toBe(true);
    expect(
      history.undo([node('world-note', 20)], [])?.nodes[0]?.position,
    ).toEqual({ x: 0, y: 0 });

    history.activate('canvas-space');
    expect(history.canUndo).toBe(true);
  });

  it('clears stale history when reloading the active Canvas', () => {
    const history = new CanvasHistoryRegistry();
    history.activate('canvas-a');
    history.takeSnapshot([node('note-a', 0)], []);

    history.activate('canvas-a', true);

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
