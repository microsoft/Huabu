// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Loading } from './Loading';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('lottie-react', () => ({
  default: () => <svg data-brand-animation />,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('keeps the overlay background but delays both animation and text until 150ms', () => {
  act(() =>
    root.render(
      <StrictMode>
        <Loading defer variant="brand" layout="overlay" message="Loading..." />
      </StrictMode>,
    ),
  );
  const surface = host.firstElementChild;
  expect(surface?.classList.contains('bg-surface')).toBe(true);
  expect(surface?.classList.contains('absolute')).toBe(true);
  expect(host.textContent).toBe('');
  expect(host.querySelector('svg')).toBeNull();
  act(() => vi.advanceTimersByTime(149));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toBe('');
  act(() => vi.advanceTimersByTime(1));
  expect(host.firstElementChild).toBe(surface);
  expect(host.querySelector('[data-loading-brand] svg')).not.toBeNull();
  expect(host.textContent).toBe('Loading...');
  act(() => root.render(<div>Ready</div>));
  expect(host.textContent).toBe('Ready');
  expect(vi.getTimerCount()).toBe(0);
});

it('skips fast loads, cleans up the timer, and gives later loads a fresh delay', () => {
  const loading = <Loading defer variant="brand" message="Loading..." />;
  act(() => root.render(loading));
  act(() => vi.advanceTimersByTime(100));
  act(() => root.render(<div>Ready</div>));
  expect(host.textContent).toBe('Ready');
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(1000));
  expect(host.querySelector('svg')).toBeNull();
  act(() => root.render(loading));
  expect(host.textContent).toBe('');
  act(() => vi.advanceTimersByTime(150));
  expect(host.textContent).toBe('Loading...');
});

it('preserves immediate indicators unless deferral is requested', () => {
  act(() => root.render(<Loading layout="inline" />));
  expect(host.querySelector('[data-loading-spinner]')).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  act(() => root.render(<Loading variant="brand" message="Saving..." />));
  expect(host.querySelector('[data-loading-brand]')).not.toBeNull();
  expect(host.textContent).toBe('Saving...');
});
