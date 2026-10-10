// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiSummaryButton } from './AiSummaryButton';
import { PreviewHeaderSlotContext } from './PreviewHeaderSlot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'node.aiSummary' ? 'AI Summary' : 'Close AI summary',
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('<AiSummaryButton>', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let toolbar: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    toolbar?.remove();
    root = undefined;
    container = undefined;
  });

  function render(
    summary?: string | null,
    keywords?: string[],
    inToolbar = false,
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    if (inToolbar) {
      toolbar = document.createElement('div');
      document.body.appendChild(toolbar);
    }
    act(() =>
      root?.render(
        <PreviewHeaderSlotContext.Provider
          value={{ el: null, leadingEl: inToolbar ? toolbar : undefined }}
        >
          <AiSummaryButton summary={summary} keywords={keywords} />
        </PreviewHeaderSlotContext.Provider>,
      ),
    );
  }

  it('portals an icon to the existing toolbar and opens reusable summary and keyword details', () => {
    render('A concise summary', ['Research'], true);
    expect(container?.textContent).toBe('');
    const toggleButton = toolbar?.querySelector<HTMLButtonElement>('button');
    expect(toggleButton).not.toBeNull();
    expect(toggleButton?.textContent).toBe('');
    expect(toggleButton?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggleButton?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'A concise summary',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Research',
    );
    const closeButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Close AI summary"]',
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(toggleButton);
    expect(toggleButton?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggleButton?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'A concise summary',
    );
  });

  it('does not reserve a summary entry for empty metadata', () => {
    render('  ', []);
    expect(container?.querySelector('button')).toBeNull();
  });

  it('supports keyword-only metadata', () => {
    render(null, ['Keyword']);
    act(() => container?.querySelector<HTMLButtonElement>('button')?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Keyword',
    );
  });
});
