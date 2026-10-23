// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, toast, ToastContainer } from './Toast';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
let toastIds: string[] = [];

afterEach(() => {
  act(() => toastIds.forEach(dismissToast));
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  toastIds = [];
  vi.useRealTimers();
});

function renderToastContainer() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ToastContainer />));
}

describe('ToastContainer', () => {
  it.each(['neutral', 'info', 'success', 'warning', 'danger'] as const)(
    'keeps the %s surface neutral and confines its tone to an unfilled icon',
    (tone) => {
      renderToastContainer();
      act(() => {
        toastIds.push(toast('Status message', { tone, duration: 0 }));
      });

      const entry = document.querySelector('[role="status"]');
      expect(entry?.classList.contains('bg-surface')).toBe(true);
      expect(entry?.classList.contains('text-fg-default')).toBe(true);
      expect(entry?.classList.contains('border-edge-default')).toBe(true);
      const icon = entry?.querySelector('[aria-hidden]');
      expect(icon?.classList.contains('h-6')).toBe(true);
      expect(icon?.classList.contains('w-6')).toBe(true);
      expect(icon?.className).not.toMatch(/\bbg-/);
      expect(
        icon?.classList.contains(
          tone === 'neutral' ? 'text-fg-muted' : `text-${tone}`,
        ),
      ).toBe(true);
    },
  );

  it('dismisses ordinary notifications after three seconds', () => {
    vi.useFakeTimers();
    renderToastContainer();
    act(() => {
      toastIds.push(toast('Saved', { tone: 'success' }));
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(document.body.textContent).not.toContain('Saved');
  });

  it('pauses on hover and resumes the remaining duration across multiple pauses', () => {
    vi.useFakeTimers();
    renderToastContainer();
    act(() => toastIds.push(toast('Saved')));
    const entry = document.querySelector('[role="status"]');
    if (!entry) throw new Error('Missing toast');
    act(() => vi.advanceTimersByTime(1000));
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(entry.isConnected).toBe(true);
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(1000));
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(entry.isConnected).toBe(true);
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(999));
    expect(entry.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(entry.isConnected).toBe(false);
  });

  it('stays paused until both hover and focus leave, including focus moves inside', () => {
    vi.useFakeTimers();
    renderToastContainer();
    act(() => {
      toastIds.push(
        toast('Choose an action', {
          action: { label: 'Continue', onClick: vi.fn() },
          secondaryAction: { label: 'Cancel', onClick: vi.fn() },
        }),
      );
    });
    const entry = document.querySelector('[role="status"]');
    if (!entry) throw new Error('Missing toast');
    const buttons = entry.querySelectorAll('button');
    act(() => vi.advanceTimersByTime(1000));
    act(() => buttons[0].focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(entry.isConnected).toBe(true);
    act(() => buttons[1].focus());
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    act(() => buttons[1].blur());
    act(() => vi.advanceTimersByTime(5000));
    expect(entry.isConnected).toBe(true);
    act(() => buttons[2].focus());
    act(() =>
      entry.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(entry.isConnected).toBe(true);
    expect(document.activeElement).toBe(buttons[2]);
    act(() => buttons[2].blur());
    act(() => vi.advanceTimersByTime(1999));
    expect(entry.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(entry.isConnected).toBe(false);
  });

  it.each(['dismiss', 'action', 'hidden'] as const)(
    'supports a standalone secondary action: %s',
    (mode) => {
      renderToastContainer();
      const onClick = vi.fn();
      act(() => {
        toastIds.push(
          toast('Secondary only', {
            secondaryAction: { label: 'Continue', onClick },
            ...(mode === 'hidden' ? { dismissible: false } : {}),
          }),
        );
      });
      const entry = document.querySelector('[role="status"]');
      if (!entry) throw new Error('Missing toast');
      const close =
        entry.querySelector<HTMLButtonElement>('button[aria-label]');
      if (mode === 'hidden') {
        expect(close).toBeNull();
        expect(entry.querySelector('.float-right')).toBeNull();
        return;
      }
      expect(close).not.toBeNull();
      act(() => {
        (mode === 'dismiss' ? close : entry.querySelector('button'))?.click();
      });
      expect(onClick).toHaveBeenCalledTimes(mode === 'action' ? 1 : 0);
      expect(entry.isConnected).toBe(false);
    },
  );

  it.each(['Keep mine', 'Load latest'])(
    'runs the %s action and dismisses the two-action toast',
    (label) => {
      renderToastContainer();
      const keepMine = vi.fn();
      const loadLatest = vi.fn();
      act(() => {
        toastIds.push(
          toast('Conflicting edits', {
            tone: 'warning',
            duration: 0,
            secondaryAction: { label: 'Keep mine', onClick: keepMine },
            action: { label: 'Load latest', onClick: loadLatest },
          }),
        );
      });
      const button = Array.from(document.querySelectorAll('button')).find(
        (element) => element.textContent === label,
      );
      expect(button?.classList.contains('bg-transparent')).toBe(true);
      expect(
        button?.classList.contains(
          label === 'Keep mine' ? 'text-fg-muted' : 'text-info',
        ),
      ).toBe(true);
      expect(button?.classList.contains('font-medium')).toBe(true);
      act(() => button?.click());
      expect(
        label === 'Keep mine' ? keepMine : loadLatest,
      ).toHaveBeenCalledOnce();
      expect(
        label === 'Keep mine' ? loadLatest : keepMine,
      ).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('Conflicting edits');
    },
  );

  it('dismisses a persistent toast without invoking its action', () => {
    renderToastContainer();
    const onClick = vi.fn();
    act(() => {
      toastIds.push(
        toast('Unable to save', {
          tone: 'danger',
          action: { label: 'Retry', onClick },
        }),
      );
    });
    const close =
      document.querySelector<HTMLButtonElement>('button[aria-label]');
    act(() => close?.click());
    expect(document.body.textContent).not.toContain('Unable to save');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('places a single text action in the wrapping message row and dismisses after it runs', () => {
    renderToastContainer();
    const onClick = vi.fn();
    act(() => {
      toastIds.push(
        toast('Saved as draft.', {
          duration: 0,
          action: { label: 'Undo', onClick },
        }),
      );
    });
    const entry = document.querySelector('[role="status"]');
    const message = entry?.querySelector('span.inline-block');
    const actionButton = message?.nextElementSibling;
    expect(entry?.classList.contains('w-fit')).toBe(true);
    expect(message?.parentElement?.classList.contains('flow-root')).toBe(true);
    expect(actionButton?.classList.contains('inline-flex')).toBe(true);
    expect(actionButton?.classList.contains('bg-transparent')).toBe(true);
    expect(actionButton?.classList.contains('text-info')).toBe(true);
    expect(actionButton?.textContent).toBe('Undo');
    act(() => {
      if (actionButton instanceof HTMLButtonElement) actionButton.click();
    });
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Saved as draft.');
  });

  it('keeps dismiss separate from the message layout', () => {
    renderToastContainer();
    act(() => {
      toastIds.push(toast('Failed to save', { tone: 'danger' }));
    });
    const entry = document.querySelector('[role="status"]');
    const close = entry?.querySelector('button[aria-label]');
    expect(close?.parentElement).toBe(entry);
    expect(close?.classList.contains('absolute')).toBe(true);
    expect(close?.classList.contains('rounded-full')).toBe(true);
    expect(
      entry?.querySelector('.float-right')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('omits the reserved dismiss space when dismissal is explicitly hidden', () => {
    renderToastContainer();
    act(() => {
      toastIds.push(
        toast('Saved as draft.', {
          duration: 0,
          dismissible: false,
          action: { label: 'Undo', onClick: vi.fn() },
        }),
      );
    });
    const entry = document.querySelector('[role="status"]');
    expect(entry?.querySelector('button[aria-label]')).toBeNull();
    expect(entry?.querySelector('.float-right')).toBeNull();
    expect(entry?.querySelector('button')?.textContent).toBe('Undo');
  });

  it('keeps danger toasts visible by default', () => {
    vi.useFakeTimers();
    renderToastContainer();

    act(() => {
      toastIds.push(toast('Failed to save', { tone: 'danger' }));
    });
    expect(document.body.textContent).toContain('Failed to save');

    act(() => vi.advanceTimersByTime(3000));
    expect(document.body.textContent).toContain('Failed to save');
  });

  it('honors an explicit duration for danger toasts', () => {
    vi.useFakeTimers();
    renderToastContainer();

    act(() => {
      toastIds.push(
        toast('Transient failure', { tone: 'danger', duration: 1000 }),
      );
    });
    expect(document.body.textContent).toContain('Transient failure');

    act(() => vi.advanceTimersByTime(1000));
    expect(document.body.textContent).not.toContain('Transient failure');
  });
});
