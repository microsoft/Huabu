// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiSummaryBanner } from './AiSummaryBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'node.aiSummary' ? 'AI Summary' : 'Close AI summary',
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<AiSummaryBanner>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('can be dismissed without changing the summary data', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<AiSummaryBanner summary="A concise summary" />));

    expect(container.textContent).toContain('A concise summary');
    const closeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close AI summary"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());

    expect(container.textContent).not.toContain('AI Summary');
    expect(container.textContent).not.toContain('A concise summary');
  });
});
