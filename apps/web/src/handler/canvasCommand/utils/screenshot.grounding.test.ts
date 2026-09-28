// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  clampVisibleCanvasCrop,
  isVisibleCanvasGroundingChrome,
} from './screenshot';

describe('visible Canvas grounding capture', () => {
  it('pads and clips a crop to the visible viewport', () => {
    expect(
      clampVisibleCanvasCrop(
        { x: 5, y: 10, width: 100, height: 80 },
        { width: 120, height: 100 },
        20,
      ),
    ).toEqual({ x: 0, y: 0, width: 120, height: 100 });
  });

  it('rejects a crop fully outside the visible viewport', () => {
    expect(
      clampVisibleCanvasCrop(
        { x: 200, y: 200, width: 20, height: 20 },
        { width: 100, height: 100 },
      ),
    ).toBeNull();
  });

  it.each([
    'react-flow__panel',
    'react-flow__handle',
    'react-flow__resize-control',
  ])('filters %s interaction chrome', (className) => {
    const element = document.createElement('div');
    element.className = className;
    expect(isVisibleCanvasGroundingChrome(element)).toBe(true);
  });

  it('keeps semantic node content', () => {
    const element = document.createElement('div');
    element.className = 'react-flow__node';
    expect(isVisibleCanvasGroundingChrome(element)).toBe(false);
  });

  it('filters the selected-Ink SVG outline but keeps the authored path', () => {
    const highlight = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path',
    );
    highlight.setAttribute('data-canvas-grounding-exclude', '');
    const ink = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    expect(isVisibleCanvasGroundingChrome(highlight)).toBe(true);
    expect(isVisibleCanvasGroundingChrome(ink)).toBe(false);
  });
});
