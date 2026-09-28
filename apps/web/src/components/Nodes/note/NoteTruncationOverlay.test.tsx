// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NOTE_SURFACE_DESIGN_CONFIG, NOTE_TRUNCATION_FADE } from './noteDesign';
import { NoteTruncationOverlay } from './NoteTruncationOverlay';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('Note truncation fade', () => {
  it.each([1, 2, 3])(
    'renders only a noninteractive neutral fade at %sx counter zoom',
    (counterZoomScale) => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <NoteTruncationOverlay counterZoomScale={counterZoomScale} />,
          ),
        );
        expect(container.querySelector('button')).toBeNull();
        expect(container.textContent).toBe('');
        const footer = container.firstElementChild as HTMLElement;
        expect(footer.getAttribute('aria-hidden')).toBe('true');
        expect(footer.style.height).toBe(
          `${NOTE_SURFACE_DESIGN_CONFIG.truncationFadeHeight * counterZoomScale}px`,
        );
        expect(footer.classList.contains('left-0')).toBe(true);
        expect(footer.classList.contains('right-0')).toBe(true);
        expect(
          container.firstElementChild?.classList.contains(
            'pointer-events-none',
          ),
        ).toBe(true);
        // Happy DOM drops custom-property gradients; assert the emitted CSS.
        expect(
          renderToStaticMarkup(
            <NoteTruncationOverlay counterZoomScale={counterZoomScale} />,
          ),
        ).toContain(`background:${NOTE_TRUNCATION_FADE}`);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
