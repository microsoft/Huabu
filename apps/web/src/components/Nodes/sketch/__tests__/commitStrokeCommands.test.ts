// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for `commitStrokeCommands` — the shared snapshot-folding seam
 * that guarantees a stroke move / erase (and the mixed variants that fold
 * into a node drag / node delete) map to a SINGLE undo entry.
 *
 * The undo-entry count is decided entirely by which history primitive the
 * seam calls (`beginGesture` = open own entry, `markGestureSnapshot` = fold
 * into the already-open entry, neither = rely on the command's own
 * snapshot), so we assert that policy via spies rather than a live store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { commitStrokeCommands } from '../sketchMerge';

import type { CanvasCommand } from '@huabu/shared';

// Hoisted so the spies exist before the (hoisted) `vi.mock` factories run.
const {
  beginGesture,
  consumeGestureSnapshot,
  executeCommands,
  markGestureSnapshot,
} = vi.hoisted(() => ({
  beginGesture: vi.fn(),
  consumeGestureSnapshot: vi.fn(),
  executeCommands: vi.fn(),
  markGestureSnapshot: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({ beginGesture, executeCommands }),
  },
}));

vi.mock('@/store/canvasHistoryManager', () => ({
  canvasHistoryManager: { consumeGestureSnapshot, markGestureSnapshot },
}));

// A caller-snapshot geometry command (produced by stroke move / partial
// erase) and a self-snapshotting whole-node delete (produced when an erase
// empties a sketch node).
const geom: CanvasCommand = {
  type: 'SET_NODE_GEOMETRY',
  items: [
    {
      nodeId: 'a' as never,
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
    },
  ],
};
const del: CanvasCommand = { type: 'DELETE_NODES', nodeIds: ['a' as never] };

beforeEach(() => {
  beginGesture.mockClear();
  consumeGestureSnapshot.mockClear();
  executeCommands.mockClear();
  markGestureSnapshot.mockClear();
});

describe('commitStrokeCommands', () => {
  it('no-ops on an empty batch (touches no history primitive)', () => {
    commitStrokeCommands([]);
    expect(executeCommands).not.toHaveBeenCalled();
    expect(beginGesture).not.toHaveBeenCalled();
    expect(markGestureSnapshot).not.toHaveBeenCalled();
    expect(consumeGestureSnapshot).not.toHaveBeenCalled();
  });

  it('opens its own single-entry gesture for a geometry batch', () => {
    commitStrokeCommands([geom]);
    expect(beginGesture).toHaveBeenCalledTimes(1);
    expect(beginGesture).toHaveBeenCalledWith('SET_NODE_GEOMETRY');
    expect(markGestureSnapshot).not.toHaveBeenCalled();
    expect(executeCommands).toHaveBeenCalledTimes(1);
    expect(executeCommands).toHaveBeenCalledWith([geom], 'ui');
  });

  it('does not open a gesture for a DELETE_NODES-only batch (it self-snapshots)', () => {
    commitStrokeCommands([del]);
    expect(beginGesture).not.toHaveBeenCalled();
    expect(markGestureSnapshot).not.toHaveBeenCalled();
    expect(executeCommands).toHaveBeenCalledTimes(1);
    expect(executeCommands).toHaveBeenCalledWith([del], 'ui');
  });

  it('folds into an already-open gesture instead of taking a new snapshot', () => {
    commitStrokeCommands([geom], { foldIntoOpenGesture: true });
    expect(markGestureSnapshot).toHaveBeenCalledTimes(1);
    expect(consumeGestureSnapshot).toHaveBeenCalledTimes(1);
    expect(beginGesture).not.toHaveBeenCalled();
    expect(executeCommands).toHaveBeenCalledTimes(1);
    expect(executeCommands).toHaveBeenCalledWith([geom], 'ui');
  });

  it('folds even a delete-only batch when asked (mixed gesture)', () => {
    commitStrokeCommands([del], { foldIntoOpenGesture: true });
    expect(markGestureSnapshot).toHaveBeenCalledTimes(1);
    expect(consumeGestureSnapshot).toHaveBeenCalledTimes(1);
    expect(beginGesture).not.toHaveBeenCalled();
    expect(executeCommands).toHaveBeenCalledTimes(1);
  });

  it('closes a folded gesture even when command execution throws', () => {
    executeCommands.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() =>
      commitStrokeCommands([del], { foldIntoOpenGesture: true }),
    ).toThrow('boom');
    expect(consumeGestureSnapshot).toHaveBeenCalledTimes(1);
  });
});
