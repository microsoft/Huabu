// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { FloatingToolbar } from './FloatingToolbar';

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function render(element: JSX.Element): HTMLElement {
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
    expect(redSwatch?.classList.contains('border-solid')).toBe(true);

    act(() => {
      redSwatch?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      redSwatch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(picked).toEqual(['red']);
  });
});
