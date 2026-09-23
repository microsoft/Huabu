// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNodeSize } from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '@/handler/canvasCommand/uiIntent';
import { getNodeFontFit } from '@/utils/node/fontFit';
import { QUESTION_NODE_DEFAULT_FONT_SIZE } from '@/utils/node/nodeFontConfig';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';

import type { Node } from '@xyflow/react';

const state = () => useCanvasStore.getState();
const executeCommands = state().executeCommands;
const base = QUESTION_NODE_DEFAULT_FONT_SIZE;
const questionId = 'node-scale';

function question(extra: Partial<Node> = {}): Node {
  return {
    id: questionId,
    type: 'question',
    selected: true,
    position: { x: 21.125, y: 42.75 },
    style: { width: 321.125, opacity: 0.75 },
    data: {
      label: 'Scale this card',
      content: 'Keep this prompt',
      threadId: 'thread-scale',
      bindingState: 'bound',
      status: 'done',
      invocationToken: 'token-scale',
      viewed: true,
      style: { accent: 'teal', fontFamily: 'serif', fontWeight: 600 },
    },
    ...extra,
  };
}

function current(): Node {
  const node = state().nodes.find((n) => n.id === questionId);
  if (!node) throw new Error('Missing Question fixture');
  return node;
}

function intent(percent: number) {
  return {
    type: 'SET_QUESTION_CARD_SCALE' as const,
    nodeId: questionId,
    percent,
  };
}

// The toolbar can preflight with the pure resolver before arming history.
// Do not begin a gesture for invalid input, stale targets, or exact repeats.
function commit(percent: number): boolean {
  const action = intent(percent);
  if (resolveUiIntent(action, state()).commands.length === 0) return false;
  state().beginGesture('SET_NODE_GEOMETRY');
  state().dispatchUiIntent(action);
  return true;
}

beforeEach(() => {
  vi.useFakeTimers();
  canvasHistoryManager.activate('question-scale-test', true);
  state()._setStateNoAutosave({
    executeCommands,
    canvasId: 'question-scale-test',
    nodes: [question()],
    edges: [],
    version: 1,
    isLoading: true,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
    canUndo: false,
    canRedo: false,
    rfInstance: null,
    canvasWrapper: null,
  });
});

afterEach(() => {
  // Zustand copies actions into new state objects; restoring the old object's
  // spy alone does not remove that spy from the live state.
  state()._setStateNoAutosave({ executeCommands });
  canvasHistoryManager.clear();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Question card scale through the real store and history', () => {
  it.each([10, 125.123456789, 200, 1000])(
    'commits percentage %s in one batch and one undo/redo step with no gesture warning',
    async (percent) => {
      const before = structuredClone(current());
      const execute = vi.spyOn(state(), 'executeCommands');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fontSize = (base * percent) / 100;
      const width = (321.125 * fontSize) / base;
      expect(commit(percent)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].map((c) => c.type)).toEqual([
        'MERGE_NODE_DATA',
        'SET_NODE_GEOMETRY',
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(canvasHistoryManager.gestureSnapshotTaken).toBe(false);
      expect(current().data).toEqual({
        ...before.data,
        style: { ...(before.data.style as object), fontSize },
      });
      expect(current().style).toEqual({ ...before.style, width });
      expect(current().position).toEqual(before.position);
      expect(current().selected).toBe(true);
      const after = structuredClone(current());

      await state().undo();
      expect(current().data).toEqual(before.data);
      expect(current().style).toEqual(before.style);
      expect(current().position).toEqual(before.position);
      expect(current().selected).toBe(true);
      expect(canvasHistoryManager.canUndo).toBe(false);
      expect(canvasHistoryManager.canRedo).toBe(true);

      await state().redo();
      expect(current().data).toEqual(after.data);
      expect(current().style).toEqual(after.style);
      expect(canvasHistoryManager.canRedo).toBe(false);
      await state().undo();
      expect(current().data).toEqual(before.data);
      expect(current().style).toEqual(before.style);
      expect(canvasHistoryManager.canUndo).toBe(false);
    },
  );

  it('uses live current font/width but an absolute target; preserves parent and local position', async () => {
    const child = question({
      parentId: 'node-frame',
      measured: { width: 407.123456789, height: 110 },
    });
    child.data.style = { ...(child.data.style as object), fontSize: base * 2 };
    const frame: Node = {
      id: 'node-frame',
      type: 'frame',
      position: { x: 100, y: 200 },
      style: { width: 2000, height: 2000 },
      data: { layoutMode: 'free', sizing: 'manual' },
    };
    state()._setStateNoAutosave({ nodes: [frame, child] });
    expect(commit(100)).toBe(true);
    expect(current().data.style).toEqual({
      ...(child.data.style as object),
      fontSize: base,
    });
    expect(current().style?.width).toBe((407.123456789 * base) / (base * 2));
    expect(current().parentId).toBe(child.parentId);
    expect(current().position).toEqual(child.position);
    expect(state().nodes[0]).toEqual(frame);
    await state().undo();
    expect(current().data).toEqual(child.data);
    expect(current().style).toEqual(child.style);
    expect(current().parentId).toBe(child.parentId);
    expect(current().position).toEqual(child.position);
    await state().redo();
    expect(current().style?.width).toBe((407.123456789 * base) / (base * 2));
  });

  it('clears a legacy pinned height while retaining all other style fields', async () => {
    const node = question({
      style: { width: 321.125, height: 250, opacity: 0.75 },
    });
    state()._setStateNoAutosave({ nodes: [node] });
    commit(200);
    expect(current().style).toEqual({ width: 642.25, opacity: 0.75 });
    await state().undo();
    expect(current().style).toEqual(node.style);
    await state().redo();
    expect(current().style).toEqual({ width: 642.25, opacity: 0.75 });
  });

  it('does not round fractional scales or compound repeated absolute submissions', async () => {
    const before = structuredClone(current());
    const saved: Array<{ data: Node['data']; style: Node['style'] }> = [];
    for (const percent of [137.123456789, 233.33333333333334, 10, 1000, 100]) {
      const fontSize = (base * percent) / 100;
      const fit = getNodeFontFit(current());
      if (!fit) throw new Error('Missing Question font fit');
      const width = (getNodeSize(current()).width * fontSize) / fit.fontSize;
      commit(percent);
      expect(current().data.style).toEqual({
        ...(before.data.style as object),
        fontSize,
      });
      expect(current().style?.width).toBe(width);
      expect(current().measured?.width).toBe(width);
      const nodes = state().nodes;
      for (let repeat = 0; repeat < 10; repeat++) {
        expect(commit(percent)).toBe(false);
        state().dispatchUiIntent(intent(percent));
        expect(state().nodes).toBe(nodes);
      }
      saved.push(
        structuredClone({ data: current().data, style: current().style }),
      );
    }
    for (let i = saved.length - 1; i >= 0; i--) {
      await state().undo();
      const expected = i === 0 ? before : saved[i - 1];
      expect(current().data).toEqual(expected.data);
      expect(current().style).toEqual(expected.style);
    }
    expect(canvasHistoryManager.canUndo).toBe(false);
    for (const expected of saved) {
      await state().redo();
      expect(current().data).toEqual(expected.data);
      expect(current().style).toEqual(expected.style);
    }
    expect(canvasHistoryManager.canRedo).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 9.999, 1000.001, 100])(
    'rejects invalid/default no-op %s without execution or history',
    (percent) => {
      const before = state().nodes;
      const execute = vi.spyOn(state(), 'executeCommands');
      expect(commit(percent)).toBe(false);
      state().dispatchUiIntent(intent(percent));
      expect(execute).not.toHaveBeenCalled();
      expect(state().nodes).toBe(before);
      expect(canvasHistoryManager.canUndo).toBe(false);
      expect(canvasHistoryManager.gestureSnapshotTaken).toBe(false);
    },
  );

  it.each(['missing', 'text', 'note', 'frame'])(
    'rejects a live %s target without history',
    (type) => {
      state()._setStateNoAutosave({
        nodes: type === 'missing' ? [] : [question({ type })],
      });
      const before = state().nodes;
      expect(commit(200)).toBe(false);
      state().dispatchUiIntent(intent(200));
      expect(state().nodes).toBe(before);
      expect(canvasHistoryManager.canUndo).toBe(false);
    },
  );

  it('keeps redo available after rejected and no-op submissions', async () => {
    commit(200);
    await state().undo();
    for (const percent of [100, 0, NaN, 1001]) {
      expect(commit(percent)).toBe(false);
      state().dispatchUiIntent(intent(percent));
    }
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(canvasHistoryManager.canRedo).toBe(true);
    await state().redo();
    expect(current().data.style).toMatchObject({ fontSize: base * 2 });
    expect(current().style?.width).toBe(642.25);
  });

  it('documents the caller-snapshot warning without beginGesture, despite automatic mixed-batch undo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = structuredClone(current());
    state().dispatchUiIntent(intent(200));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[canvasStore] snapshot:"caller" command executed without beginGesture():',
      'MERGE_NODE_DATA, SET_NODE_GEOMETRY',
    );
    await state().undo();
    expect(current().data).toEqual(before.data);
    expect(current().style).toEqual(before.style);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});
