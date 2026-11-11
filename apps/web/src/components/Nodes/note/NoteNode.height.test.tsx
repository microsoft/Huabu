// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autoHeightKey } from '@huabu/shared/canvas-engine';

import { NoteNode, type NoteNodeType } from './NoteNode';

import type * as CanvasEngine from '@huabu/shared/canvas-engine';
import type { Node, NodeProps } from '@xyflow/react';
import type * as ReactI18next from 'react-i18next';

const mocks = vi.hoisted(() => ({
  nodes: [] as Node[],
  zoom: 1,
  mode: 'overview' as 'minimal' | 'overview' | 'reading',
  callbacks: [] as Array<() => void>,
  disconnect: vi.fn(),
  propose: vi.fn(),
  canWrite: true,
  update: vi.fn(),
  move: vi.fn(),
}));
vi.mock('@huabu/shared/canvas-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof CanvasEngine>();
  return { ...actual, autoHeightKey: vi.fn(actual.autoHeightKey) };
});
vi.mock('@xyflow/react', () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ transform: [0, 0, mocks.zoom] }),
}));
vi.mock('@/store/canvasStore', () => {
  const getState = () => ({
    nodes: mocks.nodes,
    canvasId: 'c1',
    updateNodeData: mocks.update,
    moveNoteBlockIntoNote: mocks.move,
  });
  return {
    selectCanWriteCanvas: () => mocks.canWrite,
    default: Object.assign(
      (select: (state: unknown) => unknown) => select(getState()),
      { getState },
    ),
  };
});
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useNodePresentation', () => ({
  useNodePresentation: () => ({ mode: mocks.mode, isVisible: true }),
}));
vi.mock('../shared/nodeHydrationScheduler', () => ({
  useDeferredHydration: () => true,
}));
vi.mock('../shared/height/useHeightMode', () => ({
  useHeightMode: () => mocks.nodes[0].data.heightMode,
}));
vi.mock('../shared/height/commitQueue', () => ({
  proposeMeasuredHeight: mocks.propose,
  cancelMeasuredHeight: vi.fn(),
}));
vi.mock('./heightMemory', () => ({ useTrackNoteFixedHeight: vi.fn() }));
vi.mock('./useAutoHeightInvariant', () => ({
  useAutoHeightInvariant: vi.fn(),
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../MissingFileBanner', () => ({ MissingFileBanner: () => null }));
vi.mock('@/components/Common/FloatingToolbar', () => ({
  FloatingToolbar: { ActionButton: () => null },
}));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock('@/components/Milkdown', () => ({
  MilkdownPreview: () => <div className="ProseMirror">Document</div>,
}));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewNode: vi.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Missing Note test element or observer');
  return value;
}
let container: HTMLDivElement;
let root: Root;
const render = () =>
  act(() =>
    root.render(
      <NoteNode
        {...({
          id: 'n1',
          data: { ...mocks.nodes[0].data },
          selected: true,
        } as NodeProps<NoteNodeType>)}
      />,
    ),
  );

beforeEach(() => {
  mocks.canWrite = true;
  mocks.update.mockReset();
  mocks.move.mockReset();
  mocks.nodes = [
    {
      id: 'n1',
      type: 'note',
      selected: true,
      position: { x: 0, y: 0 },
      style: { width: 400, height: 300 },
      data: { content: 'Document', heightMode: 'auto' },
    },
  ];
  mocks.zoom = 1;
  mocks.mode = 'overview';
  mocks.callbacks = [];
  mocks.disconnect.mockReset();
  vi.mocked(autoHeightKey).mockClear();
  mocks.propose.mockReset();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        mocks.callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        mocks.disconnect('resize');
      }
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {
        mocks.disconnect('mutation');
      }
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('mounted Note actual-width measurement', () => {
  it.each([false, true])(
    'inline note drops respect write permission (write: %s)',
    (write) => {
      mocks.canWrite = write;
      render();
      const target = required(
        container.querySelector('.relative.h-full.w-full.overflow-hidden'),
      );
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: ['application/x-huabu-dnd'],
          getData: () =>
            JSON.stringify({
              dragId: 'test-drop',
              kind: 'note',
              origin: { type: 'user-excerpt' },
              data: { content: 'Added' },
            }),
        },
      });
      act(() => target.dispatchEvent(event));
      if (write)
        expect(mocks.update).toHaveBeenCalledWith('n1', {
          content: 'Document\n\nAdded',
        });
      else expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.move).not.toHaveBeenCalled();
    },
  );

  it.each(['overview', 'reading'] as const)(
    'skips fixed minimal keys and resumes measurement in %s',
    (mode) => {
      mocks.nodes[0].data.heightMode = 'fixed';
      mocks.mode = 'minimal';
      render();
      mocks.nodes[0].data.content = 'Updated while hidden';
      render();
      expect(autoHeightKey).not.toHaveBeenCalled();
      expect(mocks.callbacks).toHaveLength(0);

      const host = required(
        container.querySelector<HTMLElement>('[data-note-content-host]'),
      );
      Object.defineProperty(host, 'clientWidth', { value: 398 });
      Object.defineProperty(
        host.querySelector('.ProseMirror'),
        'scrollHeight',
        {
          value: 500,
        },
      );
      mocks.mode = mode;
      render();
      expect(autoHeightKey).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ content: 'Updated while hidden' }),
        }),
      );
      expect(mocks.callbacks).toHaveLength(1);
      expect(mocks.propose).not.toHaveBeenCalled();

      mocks.mode = 'minimal';
      vi.mocked(autoHeightKey).mockClear();
      render();
      expect(autoHeightKey).not.toHaveBeenCalled();
      expect(mocks.disconnect).toHaveBeenCalledWith('resize');
      expect(mocks.disconnect).toHaveBeenCalledWith('mutation');
      expect(mocks.nodes[0].style).toEqual({ width: 400, height: 300 });
    },
  );

  it('resumes auto measurement while remaining minimal', () => {
    mocks.nodes[0].data.heightMode = 'fixed';
    mocks.mode = 'minimal';
    render();
    const host = required(
      container.querySelector<HTMLElement>('[data-note-content-host]'),
    );
    Object.defineProperty(host, 'clientWidth', { value: 398 });
    Object.defineProperty(host.querySelector('.ProseMirror'), 'scrollHeight', {
      value: 500,
    });
    mocks.nodes[0].data.heightMode = 'auto';
    render();
    expect(mocks.callbacks).toHaveLength(1);
    expect(mocks.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({ measuredFor: autoHeightKey(mocks.nodes[0]) }),
    );
  });

  it('captures the measured width, rejects lagging DOM and old callbacks, and ignores zoom', () => {
    render();
    const host = required(
      container.querySelector<HTMLElement>('[data-note-content-host]'),
    );
    const prose = required(host.querySelector<HTMLElement>('.ProseMirror'));
    Object.defineProperty(host, 'clientWidth', {
      value: 398,
      configurable: true,
    });
    Object.defineProperty(prose, 'scrollHeight', {
      value: 200,
      configurable: true,
    });
    const oldCallback = mocks.callbacks[0];
    act(oldCallback);
    expect(mocks.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({ measuredFor: autoHeightKey(mocks.nodes[0]) }),
    );
    mocks.propose.mockClear();
    mocks.nodes = [{ ...mocks.nodes[0], style: { width: 800, height: 300 } }];
    act(oldCallback);
    render();
    expect(mocks.propose).not.toHaveBeenCalled();
    Object.defineProperty(host, 'clientWidth', { value: 798 });
    Object.defineProperty(prose, 'scrollHeight', { value: 100 });
    act(oldCallback);
    expect(mocks.propose).not.toHaveBeenCalled();
    act(required(mocks.callbacks.at(-1)));
    expect(mocks.propose).toHaveBeenCalledOnce();
    expect(mocks.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({ measuredFor: autoHeightKey(mocks.nodes[0]) }),
    );
    mocks.propose.mockClear();
    mocks.zoom = 0.5;
    render();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(host.style.paddingInline).toBe('16px');
    expect(
      container.querySelector<HTMLElement>('.huabu-note-scroll-frame')?.style
        .transform,
    ).toBe('');
  });

  it('retains fixed-height scrolling without proposing auto geometry', () => {
    mocks.nodes[0].data.heightMode = 'fixed';
    render();
    const host = required(
      container.querySelector<HTMLElement>('[data-note-content-host]'),
    );
    Object.defineProperty(host, 'clientWidth', { value: 398 });
    Object.defineProperty(host.querySelector('.ProseMirror'), 'scrollHeight', {
      value: 500,
    });
    act(mocks.callbacks[0]);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-note-scroll-enabled="true"]'),
    ).not.toBeNull();
  });
});
