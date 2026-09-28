// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { NodeRef } from './NodeRef';

import type { ReactFlowInstance } from '@xyflow/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('NodeRef canvas navigation', () => {
  let container: HTMLDivElement;
  let wrapper: HTMLDivElement;
  let root: Root;
  const initialState = useCanvasStore.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    wrapper = document.createElement('div');
    Object.defineProperties(wrapper, {
      clientWidth: { value: 1800 },
      clientHeight: { value: 1000 },
    });
    wrapper.style.setProperty('--canvas-inset-left', '260px');
    wrapper.style.setProperty('--canvas-inset-right', '420px');
    document.body.append(wrapper, container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    wrapper.remove();
    useCanvasStore.setState(initialState);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { targetX: 100, expectedX: 84, mounted: true },
    { targetX: 500, expectedX: -44, mounted: true },
    { targetX: 250, expectedX: null, mounted: true },
    { targetX: 500, expectedX: null, mounted: false },
  ])(
    'reveals reference at $targetX with canvas mounted=$mounted',
    ({ targetX, expectedX, mounted }) => {
      const selectNodes = vi.fn();
      const setViewport = vi.fn().mockResolvedValue(true);
      const instance = {
        getInternalNode: () => ({
          measured: { width: 200, height: 120 },
          internals: { positionAbsolute: { x: targetX, y: 100 } },
        }),
        getViewport: () => ({ x: 0, y: 0, zoom: 2 }),
        setViewport,
      } as unknown as ReactFlowInstance;
      useCanvasStore.setState({
        nodes: [
          {
            id: 'target',
            type: 'note',
            position: { x: targetX, y: 100 },
            data: { label: 'Target' },
          },
        ],
        rfInstance: instance,
        canvasWrapper: mounted ? wrapper : null,
        selectNodes,
      });
      act(() => root.render(<NodeRef nodeId="target" />));
      act(() =>
        container.querySelector<HTMLElement>('[role="button"]')?.click(),
      );
      expect(selectNodes).toHaveBeenCalledWith(['target']);
      act(() => vi.advanceTimersToNextFrame());
      if (expectedX === null) {
        expect(setViewport).not.toHaveBeenCalled();
      } else {
        expect(setViewport).toHaveBeenCalledWith(
          { x: expectedX, y: 0, zoom: 2 },
          expect.objectContaining({ duration: 300, interpolate: 'linear' }),
        );
      }
    },
  );
});
