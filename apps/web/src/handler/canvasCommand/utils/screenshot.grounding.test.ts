// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  clampVisibleCanvasCrop,
  freezeVisibleCanvasPresentation,
  GroundingSelectionOutsideViewportError,
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

  it('exposes a distinct error for a grounding crop outside the viewport', () => {
    expect(new GroundingSelectionOutsideViewportError()).toMatchObject({
      name: 'GroundingSelectionOutsideViewportError',
      message: 'Grounding selection is outside the visible Canvas',
    });
  });

  it('freezes the visible DOM and live form state before rasterization', () => {
    const root = document.createElement('div');
    root.className = 'react-flow';
    const label = document.createElement('span');
    label.textContent = 'Submitted view';
    const input = document.createElement('input');
    input.value = 'Submitted value';
    const scroller = document.createElement('div');
    scroller.append(document.createElement('div'));
    scroller.scrollTop = 42;
    root.append(label, input, scroller);
    document.body.appendChild(root);

    const snapshot = freezeVisibleCanvasPresentation(root, {
      width: 800,
      height: 600,
    });
    try {
      label.textContent = 'Later view';
      input.value = 'Later value';

      expect(snapshot.dataset.canvasGroundingSnapshot).toBe('');
      expect(snapshot.querySelector('span')?.textContent).toBe(
        'Submitted view',
      );
      expect(snapshot.querySelector('input')?.value).toBe('Submitted value');
      expect(snapshot.querySelector('div')?.scrollTop).toBe(42);
      expect(snapshot.style.width).toBe('800px');
      expect(snapshot.style.height).toBe('600px');
    } finally {
      snapshot.remove();
      root.remove();
    }
  });

  it('materializes loaded image pixels before asynchronous rasterization', () => {
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({
        drawImage,
      } as unknown as CanvasRenderingContext2D);
    const root = document.createElement('div');
    root.className = 'react-flow';
    const image = document.createElement('img');
    image.src = '/artifact.png';
    image.className = 'artifact-image';
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 640 },
      naturalHeight: { value: 480 },
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    root.appendChild(image);
    document.body.appendChild(root);

    const snapshot = freezeVisibleCanvasPresentation(root, {
      width: 800,
      height: 600,
    });
    try {
      image.src = '/replacement.png';

      expect(snapshot.querySelector('img')).toBeNull();
      const frozenImage = snapshot.querySelector('canvas');
      expect(frozenImage).toMatchObject({ width: 640, height: 480 });
      expect(frozenImage?.className).toBe('artifact-image');
      expect(frozenImage?.style.width).toBe('320px');
      expect(frozenImage?.style.height).toBe('240px');
      expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 640, 480);
    } finally {
      snapshot.remove();
      root.remove();
      getContext.mockRestore();
    }
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
