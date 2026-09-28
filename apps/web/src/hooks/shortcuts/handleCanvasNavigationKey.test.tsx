// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { handleCanvasNavigationKey } from './handleCanvasNavigationKey';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('native navigation boundary', () => {
  it('shields portal controls without cancelling defaults, keyup, or unrelated keys', () => {
    const host = document.createElement('div');
    const portal = document.createElement('div');
    document.body.append(host, portal);
    const root = createRoot(host);
    const ancestor = vi.fn();
    const keyup = vi.fn();
    act(() =>
      root.render(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Simulated ancestor event boundary, not an interactive control.
        <div onKeyDown={ancestor} onKeyUp={keyup}>
          {createPortal(
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- The button/input own interaction; this wrapper only isolates their bubbling events.
            <div onKeyDown={handleCanvasNavigationKey}>
              <button>Control</button>
              <input aria-label="Width" />
            </div>,
            portal,
          )}
        </div>,
      ),
    );
    try {
      for (const target of portal.querySelectorAll('button, input')) {
        for (const key of [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          ' ',
        ]) {
          for (const shiftKey of [false, true]) {
            ancestor.mockClear();
            const event = new KeyboardEvent('keydown', {
              key,
              shiftKey,
              bubbles: true,
              cancelable: true,
            });
            act(() => target.dispatchEvent(event));
            expect(ancestor).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
          }
        }
        for (const key of ['Escape', 'Tab', 'Enter', 'PageDown', 'Home', 'c']) {
          ancestor.mockClear();
          act(() =>
            target.dispatchEvent(
              new KeyboardEvent('keydown', { key, bubbles: true }),
            ),
          );
          expect(ancestor).toHaveBeenCalledOnce();
        }
        keyup.mockClear();
        act(() =>
          target.dispatchEvent(
            new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
          ),
        );
        expect(keyup).toHaveBeenCalledOnce();
      }
    } finally {
      act(() => root.unmount());
      host.remove();
      portal.remove();
    }
  });
});
