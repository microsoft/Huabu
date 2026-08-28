// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MissingNodesSummary } from './MissingNodesSummary';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<MissingNodesSummary>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  const renderSummary = (
    props: Partial<React.ComponentProps<typeof MissingNodesSummary>> = {},
  ) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <MissingNodesSummary
          count={3}
          isActive={false}
          isDisabled={false}
          onToggle={() => undefined}
          onClear={() => undefined}
          {...props}
        />,
      );
    });
  };

  it('toggles the missing-node filter from the count button', () => {
    const onToggle = vi.fn();
    renderSummary({ onToggle });

    const toggle = container?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    act(() => toggle?.click());

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('offers an explicit clear action while active', () => {
    const onClear = vi.fn();
    renderSummary({ isActive: true, onClear });

    const clear = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="layers.clearMissingFilter"]',
    );
    act(() => clear?.click());

    expect(clear).not.toBeNull();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('disables filter changes while canvas search is active', () => {
    renderSummary({ isDisabled: true });

    expect(
      container?.querySelector<HTMLButtonElement>(
        'button[aria-pressed="false"]',
      )?.disabled,
    ).toBe(true);
  });
});
