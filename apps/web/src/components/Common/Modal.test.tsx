// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
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

  it('honors initial focus and restores the trigger on close', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const cancelRef = createRef<HTMLButtonElement>();
    try {
      await act(async () => {
        root.render(
          <Modal
            isOpen
            title="Confirm"
            onClose={vi.fn()}
            initialFocusRef={cancelRef}
            footer={<Button ref={cancelRef}>Cancel</Button>}
          />,
        );
      });
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(cancelRef.current),
      );
      await act(async () => {
        root.render(<Modal isOpen={false} onClose={vi.fn()} />);
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      trigger.remove();
    }
  });

  it('focuses an empty dialog and bounds long content to the viewport', async () => {
    await act(async () => {
      root.render(<Modal isOpen title="Details" onClose={vi.fn()} />);
    });
    const dialog = document.querySelector('[role="dialog"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(dialog?.classList.contains('overflow-y-auto')).toBe(true);
    expect(dialog?.className).toContain('max-h-[calc(100dvh-');
  });
});
