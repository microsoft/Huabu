// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Popover } from './Popover';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
});

describe('Popover', () => {
  it('dismisses before a canvas capture handler consumes an outside pointer press', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const canvas = document.createElement('div');
    document.body.appendChild(canvas);
    const events: string[] = [];
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        events.push('canvas');
        event.stopPropagation();
        event.stopImmediatePropagation();
      },
      true,
    );
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <Popover onDismiss={() => events.push('dismiss')}>
          <Button>Popover content</Button>
        </Popover>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() =>
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    );
    expect(events).toEqual(['dismiss', 'canvas']);
  });

  it('runs initial focus once after the anchored panel becomes visible', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const reference = document.createElement('button');
    container.appendChild(reference);
    let panel: HTMLDivElement | null = null;
    const focus = vi.fn(() => {
      expect(panel?.style.visibility).toBe('visible');
      panel?.querySelector('button')?.focus();
    });
    const renderPanel = () => (
      <Popover
        reference={reference}
        contentRef={(element) => {
          panel = element;
        }}
        onOpenAutoFocus={focus}
      >
        <Button>Destination</Button>
      </Popover>
    );
    await act(async () => root?.render(renderPanel()));
    expect(focus).toHaveBeenCalledOnce();
    await act(async () => root?.render(renderPanel()));
    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement?.textContent).toBe('Destination');
  });

  it('updates the available width when a coordinate boundary changes', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    let boundaryWidth = 220;
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(40, 20, boundaryWidth, 400),
    );
    root = createRoot(container);
    act(() => {
      root?.render(
        <Popover
          boundary={container}
          viewportMargin={10}
          position={{ x: 250, y: 40 }}
        >
          <span>Content</span>
        </Popover>,
      );
    });
    const panel = document.querySelector<HTMLElement>('[data-floating-chrome]');
    expect(panel?.style.getPropertyValue('--popover-available-width')).toBe(
      '200px',
    );
    boundaryWidth = 160;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(panel?.style.getPropertyValue('--popover-available-width')).toBe(
      '140px',
    );
  });

  it('blurs focused content before outside dismissal but not on Escape', async () => {
    const events: string[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Popover onDismiss={() => events.push('dismiss')}>
          <input onBlur={() => events.push('blur')} />
        </Popover>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = document.querySelector('input');
    if (!input) throw new Error('Missing popover input');
    act(() => input.focus());
    act(() =>
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      ),
    );
    expect(events).toEqual(['blur', 'dismiss']);
    events.length = 0;
    act(() => input.focus());
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(events).toEqual(['dismiss']);
  });

  it('keeps reference presses available and dismisses on outside press or Escape', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const reference = document.createElement('button');
    document.body.appendChild(reference);
    const onDismiss = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Popover reference={reference} onDismiss={onDismiss}>
          <span>Anchored content</span>
        </Popover>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    reference.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    const panel = document.querySelector(
      '[data-floating-chrome]',
    ) as HTMLElement;
    expect(panel.style.transform).toBe('');
  });

  it('marks its portal root as floating chrome', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <Popover position={{ x: 20, y: 20 }}>
          <span>Content</span>
        </Popover>,
      );
    });

    const content = Array.from(document.body.querySelectorAll('span')).find(
      (element) => element.textContent === 'Content',
    );
    expect(content?.parentElement?.hasAttribute('data-floating-chrome')).toBe(
      true,
    );
  });
});
