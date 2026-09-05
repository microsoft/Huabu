// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstructionFrameBadge } from './InstructionFrameBadge.tsx';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('InstructionFrameBadge', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it.each([
    ['prompt', 'node.promptFrameBadge', 'bg-info'],
    ['skill', 'node.skillFrameBadge', 'bg-success'],
  ] as const)('renders the %s semantic pill', (kind, label, tone) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<InstructionFrameBadge kind={kind} />));

    const badge = container.querySelector('span');
    expect(badge?.textContent).toBe(label);
    expect(badge?.classList.contains(tone)).toBe(true);
    expect(badge?.classList.contains('text-fg-inverse')).toBe(true);
    expect(badge?.classList.contains('rounded-full')).toBe(true);
    expect(badge?.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    act(() => root.unmount());
  });
});
