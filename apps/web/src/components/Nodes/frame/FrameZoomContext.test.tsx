// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
  FrameZoomController,
  FrameZoomProvider,
  useFrameRegionVisible,
  useFrameSuppressed,
} from './FrameZoomContext';

import type { Node } from '@xyflow/react';

const mock = vi.hoisted(() => ({ flow: undefined as unknown }));
vi.mock('@xyflow/react', () => ({ useStoreApi: () => mock.flow }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('isolates canvases, updates only changed booleans, clears on navigation and unsubscribes', () => {
  const nodes: Node[] = [
    {
      id: 'frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 1400, height: 700 },
      data: {},
    },
    {
      id: 'child',
      type: 'note',
      parentId: 'frame',
      position: { x: 20, y: 64 },
      style: { width: 400, height: 320 },
      data: {},
    },
  ];
  const flow = createStore(() => ({ nodes, transform: [0, 0, 0.3] }));
  const unsubscribed = vi.fn();
  const originalSubscribe = flow.subscribe;
  flow.subscribe = (listener) => {
    const stop = originalSubscribe(listener);
    return () => {
      unsubscribed();
      stop();
    };
  };
  mock.flow = flow;
  let renders = 0;
  function Readout({ name }: { name: string }) {
    const visible = useFrameRegionVisible('frame');
    const suppressed = useFrameSuppressed('child');
    if (name === 'active') renders++;
    return <div data-name={name}>{`${visible}/${suppressed}`}</div>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (scope: string) =>
    act(() =>
      root.render(
        <>
          <FrameZoomProvider>
            <FrameZoomController scopeKey={scope} />
            <Readout name="active" />
          </FrameZoomProvider>
          <FrameZoomProvider>
            <Readout name="isolated" />
          </FrameZoomProvider>
        </>,
      ),
    );
  const value = (name: string) =>
    container.querySelector(`[data-name="${name}"]`)?.textContent;
  try {
    render('one');
    expect(value('active')).toBe('false/false');
    act(() => flow.setState({ transform: [0, 0, 0.14] }));
    expect(value('active')).toBe('true/true');
    expect(value('isolated')).toBe('false/false');
    const count = renders;
    act(() => flow.setState({ transform: [500, 100, 0.14] }));
    act(() => flow.setState({ transform: [500, 100, 0.18] }));
    expect(renders).toBe(count);
    expect(value('active')).toBe('true/true');
    render('two');
    expect(value('active')).toBe('false/false');
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    act(() => flow.setState({ transform: [0, 0, 0.14] }));
    act(() => flow.setState({ nodes: [] }));
    expect(value('active')).toBe('false/false');
  } finally {
    act(() => root.unmount());
  }
  expect(unsubscribed).toHaveBeenCalledTimes(2);
});
