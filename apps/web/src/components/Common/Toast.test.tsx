// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, toast, ToastContainer } from './Toast';

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
