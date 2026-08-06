// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

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
