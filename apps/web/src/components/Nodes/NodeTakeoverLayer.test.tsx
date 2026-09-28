// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { NodeTakeoverLayer } from './NodeTakeoverLayer';

const fixture = vi.hoisted(() => ({
  domNode: null as HTMLElement | null,
  setMark: vi.fn(),
}));
vi.mock('@xyflow/react', () => ({
  useInternalNode: () => ({}),
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ domNode: fixture.domNode }),
}));
vi.mock('@/hooks/useNodeTakeover', () => ({
  useNodeTakeover: () => ({
    stage: 'collapsed',
    size: 40,
    point: { x: 50, y: 50 },
    glideProgress: 1,
  }),
}));
vi.mock('@/hooks/useTakeoverMarkDrag', () => ({
  useTakeoverMarkDrag: () => ({}),
}));
vi.mock('@/store/nodeCollapseStore', () => ({
  useNodeCollapseStore: (selector: (state: unknown) => unknown) =>
    selector({ setMark: fixture.setMark }),
}));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  fixture.domNode?.remove();
});

it('synchronizes a later sibling card on mount and replacement without changing progress', () => {
  fixture.domNode = document.createElement('div');
  const renderer = document.createElement('div');
  renderer.className = 'react-flow__renderer';
  const host = document.createElement('div');
  fixture.domNode.append(renderer, host);
  document.body.append(fixture.domNode);
  function Fixture({ version }: { version: number }) {
    const [nodeRoot, setNodeRoot] = useState<HTMLDivElement | null>(null);
    return (
      <>
        <NodeTakeoverLayer
          nodeId="question"
          nodeRoot={nodeRoot}
          renderMark={() => <span>Avatar</span>}
        />
        <div key={version} ref={setNodeRoot} data-card />
      </>
    );
  }
  root = createRoot(host);
  act(() => root?.render(<Fixture version={0} />));
  const first = host.querySelector<HTMLElement>('[data-card]')!;
  expect(first.dataset.lodBody).toBe('hidden');
  expect(first.style.getPropertyValue('--takeover-body-opacity')).toBe('0');
  expect(
    renderer.querySelector<HTMLElement>('[data-takeover-node]')?.style.opacity,
  ).toBe('1');
  act(() => root?.render(<Fixture version={1} />));
  const second = host.querySelector<HTMLElement>('[data-card]')!;
  expect(second).not.toBe(first);
  expect(first.hasAttribute('data-lod-body')).toBe(false);
  expect(first.style.getPropertyValue('--takeover-body-opacity')).toBe('');
  expect(second.dataset.lodBody).toBe('hidden');
  expect(second.style.getPropertyValue('--takeover-body-opacity')).toBe('0');
  act(() => root?.unmount());
  root = undefined;
  expect(second.hasAttribute('data-lod-body')).toBe(false);
  expect(second.style.getPropertyValue('--takeover-body-opacity')).toBe('');
});
