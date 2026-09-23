// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MilkdownPreview } from '@/components/Milkdown/MilkdownPreview';

import {
  NOTE_CONTENT_HOST_CLASS,
  NOTE_FIRST_BLOCK_CLASS,
} from './noteContentHost';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> = [];
afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('Note content host DOM', () => {
  it('removes the first heading margin in the real Milkdown preview', async () => {
    const container = document.createElement('div');
    container.className = NOTE_CONTENT_HOST_CLASS;
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    act(() => root.render(<MilkdownPreview markdown="# Warp" />));

    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('.ProseMirror h1')).not.toBeNull(),
      );
    });

    const prose = container.querySelector('.ProseMirror');
    const heading = container.querySelector('h1');
    const firstDocumentBlock = Array.from(prose?.children ?? []).find(
      (element) => !element.classList.contains('ProseMirror-widget'),
    );
    expect(firstDocumentBlock).toBe(heading);
    expect(heading?.classList.contains(NOTE_FIRST_BLOCK_CLASS)).toBe(true);

    heading?.classList.remove(NOTE_FIRST_BLOCK_CLASS);
    prose?.insertBefore(
      Object.assign(document.createElement('div'), {
        className: 'ProseMirror-widget',
      }),
      heading,
    );
    prose?.insertBefore(
      Object.assign(document.createElement('div'), {
        className: 'ProseMirror-widget',
      }),
      heading,
    );

    await act(async () => {
      await vi.waitFor(() =>
        expect(heading?.classList.contains(NOTE_FIRST_BLOCK_CLASS)).toBe(true),
      );
    });
  });
});
