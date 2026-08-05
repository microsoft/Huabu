// @vitest-environment happy-dom

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { MilkdownPreview } from '../MilkdownPreview';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('MilkdownPreview accessibility', () => {
  it('names the textbox through StrictMode replacement and updates an override', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <StrictMode>
          <MilkdownPreview markdown="Storage survives reload." />
        </StrictMode>,
      );
    });

    await vi.waitFor(() => {
      const textbox = container?.querySelector('.ProseMirror[role="textbox"]');
      expect(textbox?.getAttribute('aria-label')).toBe(
        i18n.t('editor.readOnlyContent'),
      );
    });

    act(() => {
      root?.render(
        <StrictMode>
          <MilkdownPreview
            markdown="Storage survives reload."
            ariaLabel="Stored note preview"
          />
        </StrictMode>,
      );
    });

    await vi.waitFor(() => {
      const textbox = container?.querySelector('.ProseMirror[role="textbox"]');
      expect(textbox?.getAttribute('aria-label')).toBe('Stored note preview');
    });
  });
});
