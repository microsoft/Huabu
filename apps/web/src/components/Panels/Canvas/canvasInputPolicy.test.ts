// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  canDirectlyManipulateWithPointer,
  canManipulateCanvasWithPointer,
  canPlaceNodeWithPointer,
  closestNodeElement,
  getAvailableCanvasTools,
  isEmptyCanvasPlacementTarget,
  isEmptyPaneTarget,
  isNodePlacementTap,
  isNodeTarget,
  isPanelTarget,
  resolveCanvasToolShortcut,
  resolveNodeDraggable,
} from './canvasInputPolicy';

describe('canvas input policy', () => {
  it('exposes Select, Pan, and Lasso for the mouse but Select and Lasso for touch/pen', () => {
    expect(getAvailableCanvasTools(false)).toEqual(['select', 'pan', 'lasso']);
    expect(getAvailableCanvasTools(true)).toEqual(['select', 'lasso']);
  });

  it('maps hidden touch Select and Pan shortcuts to the internal Select state', () => {
    expect(resolveCanvasToolShortcut('select', true)).toBe('select');
    expect(resolveCanvasToolShortcut('pan', true)).toBe('select');
    expect(resolveCanvasToolShortcut('lasso', true)).toBe('lasso');
    expect(resolveCanvasToolShortcut('pan', false)).toBe('pan');
  });

  it('allows touch dragging only for nodes selected before pointer down', () => {
    expect(resolveNodeDraggable(true, false, true)).toBe(false);
    expect(resolveNodeDraggable(true, true, true)).toBe(true);
    expect(resolveNodeDraggable(undefined, true, true)).toBeUndefined();
    expect(resolveNodeDraggable(true, false, false)).toBe(true);
  });

  it('routes node placement through the active direct-manipulation pointer', () => {
    expect(canPlaceNodeWithPointer('pen', 'pen')).toBe(true);
    expect(canPlaceNodeWithPointer('touch', 'pen')).toBe(false);
    expect(canPlaceNodeWithPointer('touch', 'finger')).toBe(true);
    expect(canPlaceNodeWithPointer('pen', 'finger')).toBe(false);
    expect(canPlaceNodeWithPointer('pen', 'mouse')).toBe(false);
    expect(canPlaceNodeWithPointer('touch', 'mouse')).toBe(false);
  });

  it('always lets the mouse onto the canvas and gates other pointers by mode', () => {
    // Mouse is always allowed, even while an explicit touch/pen mode is active.
    expect(canManipulateCanvasWithPointer('mouse', 'mouse')).toBe(true);
    expect(canManipulateCanvasWithPointer('mouse', 'pen')).toBe(true);
    expect(canManipulateCanvasWithPointer('mouse', 'finger')).toBe(true);
    // Mouse mode ignores touchscreen and pen input.
    expect(canManipulateCanvasWithPointer('touch', 'mouse')).toBe(false);
    expect(canManipulateCanvasWithPointer('pen', 'mouse')).toBe(false);
    // Pen mode lets touch through for navigation; finger mode rejects the pen.
    expect(canManipulateCanvasWithPointer('pen', 'pen')).toBe(true);
    expect(canManipulateCanvasWithPointer('touch', 'pen')).toBe(true);
    expect(canManipulateCanvasWithPointer('touch', 'finger')).toBe(true);
    expect(canManipulateCanvasWithPointer('pen', 'finger')).toBe(false);
  });

  it('reserves touch for navigation rather than direct tools in pen mode, mouse always direct', () => {
    expect(canDirectlyManipulateWithPointer('mouse', 'mouse')).toBe(true);
    expect(canDirectlyManipulateWithPointer('mouse', 'pen')).toBe(true);
    expect(canDirectlyManipulateWithPointer('mouse', 'finger')).toBe(true);
    expect(canDirectlyManipulateWithPointer('pen', 'pen')).toBe(true);
    expect(canDirectlyManipulateWithPointer('touch', 'pen')).toBe(false);
    expect(canDirectlyManipulateWithPointer('touch', 'finger')).toBe(true);
  });

  it('places only from empty canvas surfaces', () => {
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    const background = document.createElement('div');
    background.className = 'react-flow__background';
    pane.append(background);

    for (const className of [
      'react-flow__panel',
      'react-flow__node',
      'react-flow__edge',
      'react-flow__handle',
    ]) {
      const blocked = document.createElement('div');
      blocked.className = className;
      pane.append(blocked);
      expect(isEmptyCanvasPlacementTarget(blocked)).toBe(false);
    }

    expect(isEmptyCanvasPlacementTarget(background)).toBe(true);
    expect(isEmptyCanvasPlacementTarget(document.createElement('div'))).toBe(
      false,
    );
  });

  it('treats movement below the pointer threshold as placement tap only', () => {
    expect(isNodePlacementTap(0, 0, 3, 0, 4)).toBe(true);
    expect(isNodePlacementTap(0, 0, 4, 0, 4)).toBe(false);
    expect(isNodePlacementTap(0, 0, 7, 0, 8)).toBe(true);
    expect(isNodePlacementTap(0, 0, 8, 0, 8)).toBe(false);
  });

  it('identifies panel, node, and empty-pane pointer targets', () => {
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    const panel = document.createElement('div');
    panel.className = 'react-flow__panel';
    const node = document.createElement('div');
    node.className = 'react-flow__node';
    node.setAttribute('data-id', 'node-1');
    const inNode = document.createElement('span');
    node.append(inNode);
    const background = document.createElement('div');
    background.className = 'react-flow__background';
    pane.append(background);

    expect(isPanelTarget(panel)).toBe(true);
    expect(isPanelTarget(pane)).toBe(false);
    expect(isPanelTarget(null)).toBe(false);

    expect(isNodeTarget(inNode)).toBe(true);
    expect(isNodeTarget(pane)).toBe(false);
    expect(closestNodeElement(inNode)).toBe(node);
    expect(closestNodeElement(pane)).toBeNull();
    expect(closestNodeElement(null)).toBeNull();

    expect(isEmptyPaneTarget(background)).toBe(true);
    expect(isEmptyPaneTarget(node)).toBe(false);
    expect(isEmptyPaneTarget(panel)).toBe(false);
    expect(isEmptyPaneTarget(null)).toBe(false);
  });
});
