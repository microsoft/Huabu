// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentIconPicker } from './AgentIconPicker';

import type { AgentIconValue } from '@/components/Common/AgentIcon';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function open(
  value: AgentIconValue,
  harnessId: string | undefined,
  onChange = vi.fn<(next: AgentIconValue) => void>(),
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <AgentIconPicker
        value={value}
        onChange={onChange}
        harnessId={harnessId}
        alias="Reviewer"
      />,
    ),
  );
  act(() =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="settings.agentIcon.change"]',
      )!
      .click(),
  );
  return onChange;
}

const option = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

describe('AgentIconPicker', () => {
  it('offers only shapes when the harness has no bundled logo', () => {
    open({ shape: 'spark', color: 'blue' }, 'custom');
    expect(option('settings.agentIcon.styles.logo')).toBeNull();
    expect(option('settings.agentIcon.shapes.diamond')).not.toBeNull();
  });

  it('switches from the logo back to the shape avatar', () => {
    const onChange = open(
      { shape: 'spark', color: 'blue', brand: 'claude' },
      'claude',
    );
    expect(
      option('settings.agentIcon.styles.logo')!.getAttribute('aria-pressed'),
    ).toBe('true');
    // Shape and color apply to the shape avatar only.
    expect(option('settings.agentIcon.shapes.diamond')).toBeNull();

    act(() => option('settings.agentIcon.styles.shape')!.click());
    expect(onChange).toHaveBeenCalledWith({ shape: 'spark', color: 'blue' });
  });

  it('switches from a shape avatar to the harness logo', () => {
    const onChange = open({ shape: 'spark', color: 'blue' }, 'claude');
    expect(option('settings.agentIcon.shapes.diamond')).not.toBeNull();

    act(() => option('settings.agentIcon.styles.logo')!.click());
    expect(onChange).toHaveBeenCalledWith({
      shape: 'spark',
      color: 'blue',
      brand: 'claude',
    });
  });
});
