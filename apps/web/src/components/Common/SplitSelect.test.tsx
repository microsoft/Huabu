// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SplitSelect } from './SplitSelect';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SplitSelect', () => {
  it.each([undefined, false, true])(
    'exposes primary pressed state %s without turning its menu trigger into a toggle',
    (primaryPressed) => {
      const onPrimaryAction = vi.fn();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <SplitSelect
            options={[{ value: 'select', label: 'Select' }]}
            value="select"
            onChange={vi.fn()}
            onPrimaryAction={onPrimaryAction}
            primaryPressed={primaryPressed}
          />,
        ),
      );
      const buttons = container.querySelectorAll('button');
      expect(buttons[0].getAttribute('aria-pressed')).toBe(
        primaryPressed === undefined ? null : String(primaryPressed),
      );
      expect(buttons[1].hasAttribute('aria-pressed')).toBe(false);
      act(() => buttons[0].click());
      expect(onPrimaryAction).toHaveBeenCalledExactlyOnceWith('select');
    },
  );

  it('hides the menu button without disabling the primary action', () => {
    const onPrimaryAction = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <SplitSelect
          options={[{ value: 'lasso', label: 'Lasso' }]}
          value="lasso"
          onChange={vi.fn()}
          onPrimaryAction={onPrimaryAction}
          hideMenuButton
          primaryTitle="Lasso"
        />,
      ),
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();

    act(() => buttons[0].click());
    expect(onPrimaryAction).toHaveBeenCalledWith('lasso');
  });

  it('names both icon-only controls without relying on tooltip markup', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <SplitSelect
          options={[{ value: 'select', label: 'Select' }]}
          value="select"
          onChange={vi.fn()}
          onPrimaryAction={vi.fn()}
          iconOnly
          primaryTitle="Select tool"
          menuTitle="More tools"
        />,
      ),
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons[0].getAttribute('aria-label')).toBe('Select tool');
    expect(buttons[1].getAttribute('aria-label')).toBe('More tools');
  });
});
