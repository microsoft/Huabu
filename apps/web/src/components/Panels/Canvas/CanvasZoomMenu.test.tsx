// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { CanvasZoomMenu } from './CanvasZoomMenu';

const zoomState = vi.hoisted(() => ({
  transform: [0, 0, 1],
  nodes: [{ hidden: false, selected: true }],
}));

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ getZoom: () => 1 }),
  useStore: (select: (state: typeof zoomState) => unknown) => select(zoomState),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/utils/canvasViewport', () => ({
  fitCanvasContent: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('retains native Tab stops for dialog actions and dismisses at either boundary', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<CanvasZoomMenu />));
  const trigger = host.querySelector<HTMLButtonElement>('button');
  await act(async () => trigger?.click());
  const dialog = document.querySelector('[role="dialog"]');
  const input = dialog?.querySelector('input');
  const actions = Array.from(
    dialog?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  );
  expect(document.activeElement).toBe(input);
  expect(actions).toHaveLength(5);
  expect(
    actions.every((action) => !action.disabled && action.tabIndex === 0),
  ).toBe(true);
  const middleTab = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  act(() => input?.dispatchEvent(middleTab));
  expect(middleTab.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  act(() => actions.at(-1)?.focus());
  const lastTab = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => actions.at(-1)?.dispatchEvent(lastTab));
  expect(lastTab.defaultPrevented).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger?.click());
  const firstInput = document.querySelector('[role="dialog"] input');
  const firstTab = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => firstInput?.dispatchEvent(firstTab));
  expect(firstTab.defaultPrevented).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
