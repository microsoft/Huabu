// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNodeSize } from '@huabu/shared/canvas-engine';

import { useRevealCreatedNodes } from '@/components/Panels/Canvas/useRevealCreatedNodes';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, { awaitQuestionCreation } from './canvasStore';

import type * as CanvasApi from '../api';
import type { CanvasViewport, Point } from '@huabu/shared';
import type { ReactFlowInstance } from '@xyflow/react';

vi.mock('@/handler/canvasCommand/postEffects.web', () => ({
  runWebPostEffects: vi.fn(),
  scheduleDeferredFrameRelayout: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  postCanvasExecute: vi.fn(
    async (canvasId: string, request: { commands: unknown[] }) => ({
      canvasId,
      fromVersion: 1,
      toVersion: 2,
      results: request.commands.map(() => ({ applied: true })),
      deltas: [],
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    }),
  ),
}));

const state = () => useCanvasStore.getState();
const executeCommands = state().executeCommands;
let wrapper: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
let viewport: CanvasViewport;
const setViewport = vi.fn().mockResolvedValue(true);

function createInstance(): ReactFlowInstance {
  const instance: Pick<
    ReactFlowInstance,
    'screenToFlowPosition' | 'getViewport' | 'setViewport' | 'getInternalNode'
  > = {
    screenToFlowPosition: ({ x, y }: Point) => ({
      x: (x - 50 - viewport.x) / viewport.zoom,
      y: (y - 30 - viewport.y) / viewport.zoom,
    }),
    getViewport: () => viewport,
    setViewport,
    getInternalNode: (id: string) => {
      const node = state().nodes.find((entry) => entry.id === id);
      if (!node) return undefined;
      return {
        ...node,
        measured: getNodeSize(node),
        internals: { positionAbsolute: node.position, userNode: node, z: 0 },
      };
    },
  };
  return instance as ReactFlowInstance;
}

function Reveal({ pending = false }: { pending?: boolean }) {
  useRevealCreatedNodes(pending);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setViewport.mockClear();
  viewport = { x: -1800, y: -900, zoom: 0.75 };
  wrapper = document.createElement('div');
  Object.defineProperties(wrapper, {
    clientWidth: { value: 1400 },
    clientHeight: { value: 800 },
  });
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(50, 30, 1400, 800),
  );
  wrapper.style.setProperty('--canvas-inset-left', '200px');
  wrapper.style.setProperty('--canvas-inset-right', '700px');
  document.body.appendChild(wrapper);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  canvasHistoryManager.activate('reveal-test', true);
  state()._setStateNoAutosave({
    executeCommands,
    canvasId: 'reveal-test',
    version: 1,
    nodes: [],
    edges: [],
    isLoading: true,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    viewport,
    rfInstance: createInstance(),
    canvasWrapper: wrapper,
    pendingRevealNodeIds: [],
    pendingInlineEditNodeId: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  state()._setStateNoAutosave({
    executeCommands,
    rfInstance: null,
    canvasWrapper: null,
    pendingRevealNodeIds: [],
  });
  wrapper.remove();
  host.remove();
  canvasHistoryManager.clear();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('automatic node placement and reveal', () => {
  it.each([
    { nodeType: 'note', left: 200, right: 700, zoom: 0.75 },
    { nodeType: 'question', left: 200, right: 700, zoom: 1.5 },
    { nodeType: 'note', left: 0, right: 700, zoom: 1 },
    { nodeType: 'question', left: 0, right: 0, zoom: 0.5 },
  ] as const)(
    'centres $nodeType in the unobscured area with insets $left/$right at zoom $zoom',
    async ({ nodeType, left, right, zoom }) => {
      viewport.zoom = zoom;
      wrapper.style.setProperty('--canvas-inset-left', `${left}px`);
      wrapper.style.setProperty('--canvas-inset-right', `${right}px`);
      state().addNode({
        id: 'node-saved',
        nodeType,
        size: { width: 200, height: 100 },
        data: {
          content: 'Saved from Chat',
          origin: { type: 'user-from-chat', threadId: 'thread-chat' },
        },
      });

      const node = state().nodes[0];
      expect((node.position.x + 100) * zoom + viewport.x).toBeCloseTo(
        left + (1400 - left - right) / 2,
      );
      expect((node.position.y + 50) * zoom + viewport.y).toBeCloseTo(400);
      expect(state().pendingRevealNodeIds).toEqual(['node-saved']);
      expect(state().pendingInlineEditNodeId).toBeNull();
      if (nodeType === 'question') {
        await awaitQuestionCreation('reveal-test', 'node-saved');
      }
    },
  );

  it('preserves explicit drop positions and only reveals automatic additions in a mixed batch', () => {
    state().addNodes([
      {
        id: 'node-dropped',
        nodeType: 'note',
        placementPoint: { x: 12, y: 34 },
      },
      { id: 'node-saved', nodeType: 'note' },
    ]);
    expect(state().nodes[0].position).toEqual({ x: 12, y: 34 });
    expect(state().pendingRevealNodeIds).toEqual(['node-saved']);
    state().consumeRevealRequest(state().pendingRevealNodeIds);
    state().addNode({
      id: 'node-another-drop',
      nodeType: 'note',
      placementPoint: { x: 56, y: 78 },
    });
    expect(state().pendingRevealNodeIds).toEqual([]);
  });

  it('uses the stored viewport rather than the origin while Canvas is unmounted', () => {
    state()._setStateNoAutosave({ rfInstance: null, canvasWrapper: null });
    state().addNode({
      id: 'node-fullscreen',
      nodeType: 'note',
      size: { width: 200, height: 100 },
    });
    const node = state().nodes[0];
    expect((node.position.x + 100) * viewport.zoom + viewport.x).toBeCloseTo(
      window.innerWidth / 2,
    );
    expect((node.position.y + 50) * viewport.zoom + viewport.y).toBeCloseTo(
      window.innerHeight / 2,
    );
    expect(state().pendingRevealNodeIds).toEqual(['node-fullscreen']);
  });

  it('does not reveal existing nodes or failed creates', () => {
    state()._setStateNoAutosave({
      nodes: [
        {
          id: 'node-existing',
          type: 'note',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });
    state().addNode({ id: 'node-existing', nodeType: 'note' });
    expect(state().pendingRevealNodeIds).toEqual([]);
    state()._setStateNoAutosave({ executeCommands: vi.fn() });
    state().addNode({ id: 'node-rejected', nodeType: 'note' });
    expect(state().pendingRevealNodeIds).toEqual([]);
  });

  it('does not reveal agent command execution', () => {
    state().executeCommands(
      [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-agent',
              nodeType: 'note',
              position: { x: -9000, y: -9000 },
            },
          ],
        },
      ],
      'agent',
    );
    expect(state().pendingRevealNodeIds).toEqual([]);
  });

  it('keeps the latest successful request when an older request is consumed', () => {
    state().addNode({ id: 'node-first', nodeType: 'note' });
    const first = state().pendingRevealNodeIds;
    state().addNode({ id: 'node-second', nodeType: 'note' });
    state().consumeRevealRequest(first);
    expect(state().pendingRevealNodeIds).toEqual(['node-second']);
  });

  it('waits for Canvas, loading and initial viewport restoration before revealing a boot-time save', async () => {
    state()._setStateNoAutosave({
      rfInstance: null,
      canvasWrapper: null,
      viewport: null,
    });
    state().addNode({
      id: 'node-boot',
      nodeType: 'note',
      size: { width: 200, height: 100 },
    });
    expect(state().nodes[0].position).toEqual({ x: 0, y: 0 });
    act(() => root.render(<Reveal pending />));
    expect(state().pendingRevealNodeIds).toEqual(['node-boot']);

    act(() => {
      state()._setStateNoAutosave({
        rfInstance: createInstance(),
        canvasWrapper: wrapper,
      });
      root.render(<Reveal />);
    });
    expect(state().pendingRevealNodeIds).toEqual(['node-boot']);
    act(() => {
      state()._setStateNoAutosave({ isLoading: false });
      root.render(<Reveal pending />);
    });
    expect(state().pendingRevealNodeIds).toEqual(['node-boot']);
    expect(setViewport).not.toHaveBeenCalled();

    act(() => root.render(<Reveal />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(state().pendingRevealNodeIds).toEqual([]);
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(
      { x: 224, y: 24, zoom: viewport.zoom },
      expect.objectContaining({ duration: 400 }),
    );
    act(() => root.render(<Reveal />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(setViewport).toHaveBeenCalledTimes(1);
  });

  it('does not pan when the saved node is already fully visible', async () => {
    state().addNode({
      id: 'node-visible',
      nodeType: 'note',
      size: { width: 200, height: 100 },
    });
    state()._setStateNoAutosave({ isLoading: false });
    act(() => root.render(<Reveal />));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(state().pendingRevealNodeIds).toEqual([]);
    expect(setViewport).not.toHaveBeenCalled();
  });
});
