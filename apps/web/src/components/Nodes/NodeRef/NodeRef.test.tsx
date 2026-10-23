// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { NodeRef } from './NodeRef';

import type { ReactFlowInstance } from '@xyflow/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('NodeRef canvas navigation', () => {
  let container: HTMLDivElement;
  let wrapper: HTMLDivElement;
  let root: Root;
  const initialState = useCanvasStore.getState();
  const initialWorkspaceState = useWorkspaceStore.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      isReady: true,
      isSyncing: false,
      spaceTitles: { destination: 'Research' },
      spaceTitlesStatus: 'ready',
    });
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
    useWorkspaceStore.setState(initialWorkspaceState);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses the canonical Space name and follows renames without changing focus', () => {
    const selectNodes = vi.fn();
    useCanvasStore.setState({
      nodes: [
        {
          id: 'shortcut',
          type: 'spacePreview',
          position: { x: 0, y: 0 },
          data: { targetCanvasId: 'destination', label: 'Stale local label' },
        },
      ],
      selectNodes,
      rfInstance: null,
    });
    act(() => root.render(<NodeRef nodeId="shortcut" />));
    expect(container.textContent).toBe('Research');
    act(() =>
      useWorkspaceStore.getState().setSpaceTitle('destination', 'Renamed'),
    );
    expect(container.textContent).toBe('Renamed');
    act(() => container.querySelector<HTMLElement>('[role="button"]')?.click());
    expect(selectNodes).toHaveBeenCalledWith(['shortcut']);
  });

  it.each([null, '  ', undefined])(
    'uses the card untitled fallback for a Space title of %s',
    (title) => {
      useCanvasStore.setState({
        nodes: [
          {
            id: 'shortcut',
            type: 'spacePreview',
            position: { x: 0, y: 0 },
            data: { targetCanvasId: 'destination' },
          },
        ],
      });
      useWorkspaceStore.setState({
        spaceTitles: title === undefined ? {} : { destination: title },
      });
      act(() => root.render(<NodeRef nodeId="shortcut" />));
      expect(container.textContent).toBe('spacePreview.untitledSpace');
    },
  );

  it('preserves snapshot and attachment labels and disables deleted references', () => {
    const refreshSpaceTitles = vi.fn();
    useWorkspaceStore.setState({
      spaceTitlesStatus: 'idle',
      refreshSpaceTitles,
    });
    useCanvasStore.setState({
      nodes: [
        {
          id: 'shortcut',
          type: 'spacePreview',
          position: { x: 0, y: 0 },
          data: { targetCanvasId: 'destination' },
        },
      ],
    });
    act(() =>
      root.render(<NodeRef nodeId="shortcut" snapshotLabel="Historical" />),
    );
    act(() =>
      useWorkspaceStore.getState().setSpaceTitle('destination', 'Renamed'),
    );
    expect(container.textContent).toBe('Historical');
    act(() => useCanvasStore.setState({ nodes: [] }));
    expect(
      container.querySelector('[role="button"]')?.getAttribute('tabindex'),
    ).toBe('-1');
    expect(container.textContent).toBe('Historical');
    act(() =>
      root.render(
        <NodeRef
          attachment={{
            type: 'text',
            source: 'selection',
            originNodeId: 'shortcut',
            filename: 'Attachment',
          }}
        />,
      ),
    );
    expect(container.textContent).toBe('Attachment');
    expect(refreshSpaceTitles).not.toHaveBeenCalled();
  });

  it('loads Space metadata when the reference is rendered before its card', async () => {
    const refreshSpaceTitles = vi.fn(async () => {
      useWorkspaceStore.setState({
        spaceTitles: { destination: 'Loaded Space' },
        spaceTitlesStatus: 'ready',
      });
    });
    useWorkspaceStore.setState({
      spaceTitles: {},
      spaceTitlesStatus: 'idle',
      refreshSpaceTitles,
    });
    useCanvasStore.setState({
      nodes: [
        {
          id: 'shortcut',
          type: 'spacePreview',
          position: { x: 0, y: 0 },
          data: { targetCanvasId: 'destination' },
        },
      ],
    });
    await act(async () => root.render(<NodeRef nodeId="shortcut" />));
    expect(refreshSpaceTitles).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('Loaded Space');
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
