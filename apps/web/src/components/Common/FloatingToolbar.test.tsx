// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FloatingToolbar } from './FloatingToolbar';

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function render(element: React.JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  act(() => {
    root.render(element);
  });
  return container;
}

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  for (const container of containers) {
    container.remove();
  }
  roots = [];
  containers = [];
  document.body.replaceChildren();
});

describe('FloatingToolbar.ColorPicker', () => {
  it('keeps portal swatch clicks alive after mousedown', () => {
    const picked: string[] = [];
    const container = render(
      <FloatingToolbar.ColorPicker
        colors={[{ token: 'red', name: 'Red', value: '#f00' }]}
        value={null}
        onSelect={(token) => picked.push(token)}
        title=""
      />,
    );

    const trigger = container.querySelector('button');
    expect(trigger).not.toBeNull();
    expect(trigger?.classList.contains('bg-bg-default')).toBe(true);
    expect(trigger?.classList.contains('rounded-md')).toBe(true);

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const redSwatch = document.body.querySelector(
      'button[aria-label="Red"]',
    ) as HTMLButtonElement | null;
    expect(redSwatch).not.toBeNull();
    expect(redSwatch?.closest('div.flex.gap-0')).not.toBeNull();
    expect(redSwatch?.classList.contains('h-6')).toBe(true);
    expect(redSwatch?.classList.contains('min-h-6')).toBe(true);
    expect(redSwatch?.classList.contains('w-6')).toBe(true);
    expect(redSwatch?.classList.contains('min-w-6')).toBe(true);
    expect(redSwatch?.classList.contains('enabled:hover:bg-transparent')).toBe(
      true,
    );
    expect(redSwatch?.classList.contains('enabled:hover:bg-hover')).toBe(false);

    const redDot = redSwatch?.querySelector('span[aria-hidden]');
    expect(redDot?.classList.contains('border-solid')).toBe(true);
    expect(redDot?.classList.contains('h-3.5')).toBe(true);
    expect(redDot?.classList.contains('w-3.5')).toBe(true);

    act(() => {
      redSwatch?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(picked).toEqual(['red']);
  });
});

describe('FloatingToolbar.SizePicker', () => {
  it('renders auto height as static text with a 24px mode target', () => {
    const onToggle = vi.fn();
    const container = render(
      <FloatingToolbar.SizePicker
        width={320}
        height={180}
        onApply={vi.fn()}
        autoSize={{ active: true, onToggle }}
      />,
    );

    expect(container.querySelector('input[aria-label="Height"]')).toBeNull();

    const autoValue = container.querySelector('span.text-fg-muted.italic');
    expect(autoValue?.tagName).toBe('SPAN');
    expect(autoValue?.classList.contains('h-6')).toBe(true);
    expect(autoValue?.classList.contains('text-fg-subtle')).toBe(false);

    const toggle = container.querySelector('button');
    expect(toggle?.classList.contains('h-6')).toBe(true);
    expect(toggle?.classList.contains('w-6')).toBe(true);

    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('keeps fixed height editable with a 24px input target', () => {
    const container = render(
      <FloatingToolbar.SizePicker
        width={320}
        height={180}
        onApply={vi.fn()}
        autoSize={{ active: false, onToggle: vi.fn() }}
      />,
    );

    const heightInput = container.querySelector('input[aria-label="Height"]');
    const widthInput = container.querySelector('input[aria-label="Width"]');
    expect(widthInput?.getAttribute('name')).toBe('node-width');
    expect(heightInput?.getAttribute('name')).toBe('node-height');
    expect(heightInput?.classList.contains('h-6')).toBe(true);
    expect(container.querySelector('button')?.classList.contains('h-6')).toBe(
      true,
    );
  });
});
