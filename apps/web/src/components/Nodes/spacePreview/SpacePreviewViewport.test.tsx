// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SpacePreviewViewport,
  spacePreviewTextMetrics,
} from './SpacePreviewViewport';

import type { GetSpacePreviewSceneResponse } from '@huabu/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const scene: GetSpacePreviewSceneResponse = {
  canvasId: 'canvas-target',
  title: 'Target',
  version: 1,
  bounds: { x: 0, y: 0, width: 800, height: 300 },
  nodes: [
    {
      id: 'node-note',
      kind: 'content',
      x: 0,
      y: 0,
      width: 400,
      height: 240,
      previewText: 'Visible note body',
    },
    {
      id: 'node-image',
      kind: 'content',
      x: 450,
      y: 0,
      width: 350,
      height: 240,
      imageSrc: 'artifact-preview.png',
    },
  ],
  edges: [],
  truncated: { nodes: false, edges: false },
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});

describe('SpacePreviewViewport content', () => {
  it('keeps text at a stable screen size across local zoom', () => {
    const base = spacePreviewTextMetrics({
      bounds: scene.bounds,
      localZoom: 1,
      hostZoom: 1,
      viewportSize: { width: 800, height: 300 },
    });
    const zoomed = spacePreviewTextMetrics({
      bounds: scene.bounds,
      localZoom: 2,
      hostZoom: 1,
      viewportSize: { width: 800, height: 300 },
    });

    expect(base.fontSize).toBe(14);
    expect(zoomed.fontSize).toBe(7);
    expect(zoomed.fontSize * 2).toBe(base.fontSize);
  });

  it('bounds host zoom-out compensation', () => {
    const metrics = spacePreviewTextMetrics({
      bounds: scene.bounds,
      localZoom: 1,
      hostZoom: 0.1,
      viewportSize: { width: 800, height: 300 },
    });

    expect(metrics.fontSize).toBe(42);
  });

  it('lets host zoom-in scale text with the Preview node', () => {
    const metrics = spacePreviewTextMetrics({
      bounds: scene.bounds,
      localZoom: 1,
      hostZoom: 2,
      viewportSize: { width: 800, height: 300 },
    });

    expect(metrics.fontSize).toBe(14);
  });

  it('renders inert Note text and Image thumbnails', async () => {
    await act(async () => {
      root.render(
        <SpacePreviewViewport
          scene={scene}
          hostCanvasId="canvas-host"
          previewNodeId="node-preview"
          hostZoom={1}
        />,
      );
    });

    expect(container.textContent).toContain('Visible note body');
    expect(
      container.querySelector<HTMLElement>('[data-preview-adaptive-text]')
        ?.style.fontSize,
    ).not.toBe('');
    const image = container.querySelector('image');
    expect(image?.getAttribute('href')).toContain(
      '/api/canvas/canvas-target/artifact/artifact-preview.png',
    );
    expect(image?.closest('svg')?.classList).toContain('pointer-events-none');
  });
});
