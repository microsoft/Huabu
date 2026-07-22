import { describe, expect, it, vi } from 'vitest';

import { fitNodesOnCanvas, getReliableNodeBounds } from './focusNodesOnCanvas';

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
