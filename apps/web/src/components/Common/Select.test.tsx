// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Select } from './Select';

import type { PopoverProps } from './Popover';

const mocks = vi.hoisted(() => ({ popover: vi.fn() }));
vi.mock('./Popover', () => ({
  Popover: (props: PopoverProps) => {
    mocks.popover(props);
    return <div data-testid="menu">{props.children}</div>;
  },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function renderSelect(props: Partial<Parameters<typeof Select>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <StrictMode>
        <Select
          options={[{ value: 'external', label: 'External Agent' }]}
          value="external"
          onChange={vi.fn()}
          {...props}
        />
      </StrictMode>,
    ),
  );
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('Missing Select trigger');
  return trigger;
}

describe('Select', () => {
  it.each([
    ['bottom-left', 'bottom-start'],
    ['bottom-right', 'bottom-end'],
    ['top-left', 'top-start'],
    ['top-right', 'top-end'],
  ] as const)(
    'anchors %s menus to the live trigger',
    async (align, placement) => {
      const trigger = await renderSelect({ align });
      await act(async () => trigger.click());
      const props: PopoverProps = mocks.popover.mock.lastCall?.[0];
      expect(props.reference).toBe(trigger.parentElement);
      expect(props.placement).toBe(placement);
      expect(props.position).toBeUndefined();
    },
  );

  it('refreshes once per opening in Strict Mode and closes on trigger press', async () => {
    const onOpen = vi.fn();
    const trigger = await renderSelect({ onOpen });
    await act(async () => trigger.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => trigger.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container?.querySelector('[data-testid="menu"]')).toBeNull();
    await act(async () => trigger.click());
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('commits a selection and returns focus to the trigger', async () => {
    const onChange = vi.fn();
    const trigger = await renderSelect({ onChange });
    await act(async () => trigger.click());
    const option =
      container?.querySelector<HTMLButtonElement>('[role="option"]');
    if (!option) throw new Error('Missing Select option');
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('external');
    expect(container?.querySelector('[data-testid="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
