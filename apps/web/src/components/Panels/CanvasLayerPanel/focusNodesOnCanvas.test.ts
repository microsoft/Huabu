// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  anchorViewportCentre,
  fitNodesOnCanvas,
  getReliableNodeBounds,
  revealBoundsInViewport,
} from './focusNodesOnCanvas';

import type { ReactFlowInstance } from '@xyflow/react';

const createInstance = () => {
  const internalNodes = {
    first: {
      measured: {},
      style: { width: 200, height: 120 },
      internals: { positionAbsolute: { x: 1000, y: 500 } },
    },
    second: {
      measured: { width: 80, height: 60 },
      style: {},
      internals: { positionAbsolute: { x: 1400, y: 800 } },
    },
  };
  const fitBounds = vi.fn().mockResolvedValue(true);
  const instance = {
    getInternalNode: (id: string) =>
      internalNodes[id as keyof typeof internalNodes],
    fitBounds,
  } as unknown as ReactFlowInstance;
  return { instance, fitBounds };
};

describe('reliable canvas node bounds', () => {
  it('uses persisted style dimensions for unmeasured nodes', () => {
    const { instance } = createInstance();

    expect(getReliableNodeBounds(instance, ['first', 'second'])).toEqual({
      x: 1000,
      y: 500,
      width: 480,
      height: 360,
    });
  });

  it('fits the resolved bounds', async () => {
    const { instance, fitBounds } = createInstance();

    await expect(
      fitNodesOnCanvas(instance, ['first', 'second'], 0.2),
    ).resolves.toBe(true);

    expect(fitBounds).toHaveBeenCalledWith(
      { x: 1000, y: 500, width: 480, height: 360 },
      { padding: 0.2 },
    );
  });

  it('reports when no visible node bounds can be resolved', async () => {
    const { instance, fitBounds } = createInstance();

    await expect(fitNodesOnCanvas(instance, [])).resolves.toBe(false);
    expect(fitBounds).not.toHaveBeenCalled();
  });
});

describe('canvas viewport anchoring', () => {
  it('keeps the same flow point centred when the viewport grows', () => {
    expect(
      anchorViewportCentre(
        { x: 100, y: 40, zoom: 0.75 },
        { width: 800, height: 600 },
        { width: 1200, height: 700 },
      ),
    ).toEqual({ x: 300, y: 90, zoom: 0.75 });
  });

  it('does not move bounds that are already safely visible', () => {
    const viewport = { x: 0, y: 0, zoom: 1 };

    expect(
      revealBoundsInViewport(
        viewport,
        { width: 800, height: 600 },
        { x: 100, y: 100, width: 200, height: 120 },
      ),
    ).toBe(viewport);
  });

  it('uses the smallest pan needed to reveal clipped bounds', () => {
    expect(
      revealBoundsInViewport(
        { x: 0, y: 0, zoom: 1 },
        { width: 600, height: 500 },
        { x: 500, y: 200, width: 140, height: 100 },
        20,
      ),
    ).toEqual({ x: -60, y: 0, zoom: 1 });
  });

  it('centres oversized bounds without changing zoom', () => {
    expect(
      revealBoundsInViewport(
        { x: 10, y: 20, zoom: 2 },
        { width: 500, height: 400 },
        { x: 0, y: 10, width: 300, height: 80 },
      ),
    ).toEqual({ x: -50, y: 20, zoom: 2 });
  });
});
