// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { WorkspaceLoadingScreen } from '@/pages/WorkspaceLoadingScreen';

import { DesktopCloseOverlay } from './DesktopCloseOverlay';

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
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(
    function (this: HTMLDialogElement) {
      this.open = true;
    },
  );
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = false;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('uses the same brand indicator for loading and saving without internal stage names', () => {
  act(() => root.render(<WorkspaceLoadingScreen />));
  expect(host.textContent).toBe('');
  expect(host.querySelector('[data-loading-brand]')).toBeNull();
  act(() => vi.advanceTimersByTime(150));
  expect(host.textContent).toBe('status.loadingProgress');
  expect(host.querySelector('[data-loading-brand] svg')).not.toBeNull();
  const loadingSize = host.querySelector<HTMLElement>('[data-loading-brand]')
    ?.style.width;

  act(() => root.render(<DesktopCloseOverlay />));
  expect(host.textContent).toBe('app.savingCanvas');
  expect(host.querySelector('[data-loading-brand] svg')).not.toBeNull();
  expect(
    host.querySelector<HTMLElement>('[data-loading-brand]')?.style.width,
  ).toBe(loadingSize);
  expect(host.querySelector('[data-loading-spinner]')).toBeNull();
  expect(host.querySelector('button')).toBeNull();
});

it('keeps saving modal until settlement instead of dismissing on Escape', () => {
  act(() => root.render(<DesktopCloseOverlay />));
  const dialog = host.querySelector('dialog');
  expect(dialog?.open).toBe(true);
  expect(
    host.querySelector(`#${dialog?.getAttribute('aria-labelledby')}`)
      ?.textContent,
  ).toBe('app.savingCanvas');
  const cancel = new Event('cancel', { cancelable: true });
  act(() => dialog?.dispatchEvent(cancel));
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog?.open).toBe(true);
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  act(() => root.render(null));
  expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
});
