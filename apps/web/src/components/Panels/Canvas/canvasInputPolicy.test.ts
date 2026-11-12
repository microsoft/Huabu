// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  canStartRetainedSelectionMove,
  canDirectlyManipulateWithPointer,
  canManipulateCanvasWithPointer,
  canPlaceNodeWithPointer,
  closestNodeElement,
  getAvailableCanvasTools,
  isEmptyCanvasPlacementTarget,
  isEmptyPaneTarget,
  isLassoStartTarget,
  isNodePlacementTap,
  isNodeTarget,
  isPanelTarget,
  resolveCanvasToolShortcut,
  resolveEffectiveCanvasTool,
  resolveNodeDraggable,
} from './canvasInputPolicy';

describe('canvas input policy', () => {
  it.each(['select', 'pan', 'lasso'] as const)(
    'projects saved %s without hidden Pan or automatic touch Lasso',
    (mouseToolPreference) => {
      const state = {
        mouseToolPreference,
        pendingNodeType: null,
        explicitLassoActive: false,
      };
      expect(resolveEffectiveCanvasTool(state, false)).toBe(
        mouseToolPreference,
      );
      expect(resolveEffectiveCanvasTool(state, true)).toBe('select');
      expect(resolveEffectiveCanvasTool(state, false, true)).toBe('pan');
      expect(resolveEffectiveCanvasTool(state, true, true)).toBe('select');
      expect(
        resolveEffectiveCanvasTool(
          { ...state, explicitLassoActive: true },
          true,
        ),
      ).toBe('lasso');
      expect(
        resolveEffectiveCanvasTool(
          { ...state, pendingNodeType: 'note' },
          false,
          true,
        ),
      ).toBe('select');
      expect(
        resolveEffectiveCanvasTool(
          { ...state, pendingNodeType: 'sketch', explicitLassoActive: true },
          true,
        ),
      ).toBe('select');
    },
  );
  it.each(['data-ink-sigil-label', 'data-ink-sigil-hit-target'])(
    'reserves native input for the Sigil control %s',
    (attribute) => {
      const control = document.createElement('button');
      control.setAttribute(attribute, '');
      const child = document.createElement('span');
      control.append(child);
      expect(isPanelTarget(control)).toBe(true);
      expect(isPanelTarget(child)).toBe(true);
      expect(canStartRetainedSelectionMove(child)).toBe(false);
      expect(isLassoStartTarget(child)).toBe(false);
    },
  );

  it('exposes Select, Pan, and Lasso for the mouse but only Lasso for touch/pen', () => {
    expect(getAvailableCanvasTools(false)).toEqual(['select', 'pan', 'lasso']);
    expect(getAvailableCanvasTools(true)).toEqual(['lasso']);
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
    expect(resolveNodeDraggable(true, true, true, true)).toBe(false);
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

  it.each(['note', 'image', 'sketch', 'frame', 'text', 'audio'])(
    'allows Lasso on a %s surface without relaxing placement',
    (type) => {
      const pane = document.createElement('div');
      pane.className = 'react-flow__pane';
      const node = document.createElement('div');
      node.className = `react-flow__node react-flow__node-${type}`;
      node.setAttribute('role', 'group');
      const surface = document.createElement('span');
      node.append(surface);
      pane.append(node);

      expect(isLassoStartTarget(surface)).toBe(true);
      expect(canStartRetainedSelectionMove(surface)).toBe(true);
      expect(isLassoStartTarget(node)).toBe(true);
      expect(isLassoStartTarget(pane)).toBe(true);
      expect(isEmptyCanvasPlacementTarget(surface)).toBe(false);
      expect(isLassoStartTarget(null)).toBe(false);
      expect(isLassoStartTarget(document.createElement('div'))).toBe(false);
    },
  );

  it.each([
    '<div class="react-flow__panel"><span></span></div>',
    '<div class="react-flow__edge"><span></span></div>',
    '<div class="react-flow__handle"><span></span></div>',
    '<div class="react-flow__resize-control"><span></span></div>',
    '<div data-multi-resize-control="br"><span></span></div>',
    '<div data-video-controls="true"><video></video></div>',
    '<button><span></span></button>',
    '<a href="/"><span></span></a>',
    '<input>',
    '<textarea></textarea>',
    '<select><option>Choice</option></select>',
    '<div contenteditable="true"><span></span></div>',
    '<div role="textbox"><span></span></div>',
    '<div role="button"><span></span></div>',
    '<div role="menuitem"><span></span></div>',
    '<div role="slider" tabindex="0"><span aria-hidden="true"></span></div>',
    '<div data-keyboard-interactive><span></span></div>',
  ])('does not start Lasso on a node control: %s', (html) => {
    const node = document.createElement('div');
    node.className = 'react-flow__node react-flow__node-frame';
    node.innerHTML = html;
    const target = node.querySelector('*:last-child');
    expect(target).not.toBeNull();
    expect(isLassoStartTarget(target)).toBe(false);
    for (const descendant of node.querySelectorAll('*')) {
      expect(isLassoStartTarget(descendant)).toBe(false);
    }
  });

  it.each([
    '<div role="slider" tabindex="0"><span aria-hidden="true"></span></div>',
    '<input type="range">',
    '<button><span></span></button>',
    '<a href="/"><span></span></a>',
    '<div contenteditable="true"><span></span></div>',
    '<div class="react-flow__panel"><span></span></div>',
    '<div data-video-controls="true"><video></video></div>',
  ])('reserves controls inside retained Lasso regions: %s', (html) => {
    const node = document.createElement('div');
    node.className = 'react-flow__node react-flow__node-audio';
    node.innerHTML = html;
    for (const descendant of node.querySelectorAll('*')) {
      expect(canStartRetainedSelectionMove(descendant)).toBe(false);
    }
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

  it.each(['react-flow__handle', 'react-flow__resize-control'])(
    'reserves %s for its native control instead of retained Lasso movement',
    (controlClass) => {
      const control = document.createElement('div');
      control.className = controlClass;

      expect(canStartRetainedSelectionMove(control)).toBe(false);
      expect(canStartRetainedSelectionMove(document.createElement('div'))).toBe(
        true,
      );
    },
  );
  it('reserves multi-selection resize controls and their paint for direct manipulation', () => {
    const control = document.createElement('div');
    control.dataset.multiResizeControl = 'br';
    const grip = document.createElement('span');
    control.append(grip);
    expect(isPanelTarget(control)).toBe(true);
    expect(isPanelTarget(grip)).toBe(true);
    expect(isPanelTarget(document.createElement('div'))).toBe(false);
  });

  it('treats active video controls as native interaction but not an inactive poster', () => {
    const surface = document.createElement('div');
    const video = document.createElement('video');
    surface.append(video);
    surface.dataset.videoControls = 'true';
    expect(isPanelTarget(video)).toBe(true);
    surface.dataset.videoControls = 'false';
    expect(isPanelTarget(video)).toBe(false);
  });
});
