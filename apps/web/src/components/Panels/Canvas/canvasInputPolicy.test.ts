import { describe, expect, it } from 'vitest';

import {
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
  it('exposes Select, Pan, and Lasso on desktop but only Lasso on touch', () => {
    expect(getAvailableCanvasTools('desktop')).toEqual([
      'select',
      'pan',
      'lasso',
    ]);
    expect(getAvailableCanvasTools('touch')).toEqual(['lasso']);
  });

  it('maps hidden touch Select and Pan shortcuts to the internal Select state', () => {
    expect(resolveCanvasToolShortcut('select', 'touch')).toBe('select');
    expect(resolveCanvasToolShortcut('pan', 'touch')).toBe('select');
    expect(resolveCanvasToolShortcut('lasso', 'touch')).toBe('lasso');
    expect(resolveCanvasToolShortcut('pan', 'desktop')).toBe('pan');
  });

  it('allows touch dragging only for nodes selected before pointer down', () => {
    expect(resolveNodeDraggable(true, false, 'touch')).toBe(false);
    expect(resolveNodeDraggable(true, true, 'touch')).toBe(true);
    expect(resolveNodeDraggable(undefined, true, 'touch')).toBeUndefined();
    expect(resolveNodeDraggable(true, false, 'desktop')).toBe(true);
  });

  it('routes node placement through the active direct-manipulation pointer', () => {
    expect(canPlaceNodeWithPointer('pen', 'touch', 'pen')).toBe(true);
    expect(canPlaceNodeWithPointer('touch', 'touch', 'pen')).toBe(false);
    expect(canPlaceNodeWithPointer('touch', 'touch', 'finger')).toBe(true);
    expect(canPlaceNodeWithPointer('pen', 'touch', 'finger')).toBe(false);
    expect(canPlaceNodeWithPointer('pen', 'desktop', 'finger')).toBe(true);
    expect(canPlaceNodeWithPointer('mouse', 'desktop', 'finger')).toBe(false);
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
