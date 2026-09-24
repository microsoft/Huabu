// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasFloatingPopover } from './CanvasFloatingPopover';
import { Popover } from './Popover';

vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useStore: (selector: (state: { domNode: HTMLElement }) => unknown) =>
    selector({ domNode: document.body }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('CanvasFloatingPopover', () => {
  it.each([false, true])(
    'owns double-clicks without cancelling native defaults (nested portal: %s)',
    async (nested) => {
      const nodeDoubleClick = vi.fn();
      const inputDoubleClick = vi.fn();
      const input = <input type="number" onDoubleClick={inputDoubleClick} />;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () =>
        root?.render(
          <div role="presentation" onDoubleClick={nodeDoubleClick}>
            <CanvasFloatingPopover
              open
              anchor={{ x: 100, y: 100, width: 300, height: 200 }}
            >
              {nested ? <Popover>{input}</Popover> : input}
            </CanvasFloatingPopover>
          </div>,
        ),
      );
      const event = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
      });
      act(() => document.querySelector('input')?.dispatchEvent(event));
      expect(inputDoubleClick).toHaveBeenCalledOnce();
      expect(nodeDoubleClick).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );
});
