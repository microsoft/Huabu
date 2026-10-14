// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Modal overlay', () => {
  it('uses the visible window chrome height even when portaled to the body', () => {
    act(() => {
      root.render(<Modal isOpen title="Confirm" onClose={vi.fn()} />);
    });

    const overlay =
      document.querySelector<HTMLElement>('[role="dialog"]')?.parentElement;
    expect(overlay?.parentElement).toBe(document.body);
    expect(
      overlay?.classList.contains('top-[var(--window-chrome-height,0px)]'),
    ).toBe(true);
    expect(overlay?.style.zIndex).toBe('9999');
  });
});
