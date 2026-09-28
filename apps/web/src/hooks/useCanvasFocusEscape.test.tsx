// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Fixture containers model React Flow and shell bubble boundaries, not controls.
/* eslint-disable jsx-a11y/no-static-element-interactions */

import {
  act,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';

import {
  handleCanvasFocusEscape,
  useCanvasFocusEscape,
} from './useCanvasFocusEscape';
import { useCloseOnEscape } from './useCloseOnEscape';

const store = vi.hoisted(() => ({
  nodes: [{ id: 'media', selected: true }],
  canvasWrapper: null as HTMLElement | null,
  selectNodes: vi.fn(),
}));
const attention = vi.hoisted(() => ({ isCanvasEngaged: true }));
vi.mock('@/store/canvasAttentionStore', () => ({
  useCanvasAttentionStore: { getState: () => attention },
}));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: () => store },
}));

const flowKeyDown = vi.fn((event: ReactKeyboardEvent) => {
  // Match RF's node accessibility handler: no defaultPrevented check, and
  // input/contenteditable targets are excluded but buttons/media are not.
  if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) {
    store.selectNodes([]);
  }
});

function Menu({ portal }: { portal: boolean }) {
  const [open, setOpen] = useState(true);
  useCloseOnEscape(open, () => setOpen(false));
  if (!open) return null;
  const panel = (
    <div role="menu">
      <button aria-label="Menu item">Item</button>
    </div>
  );
  return portal ? createPortal(panel, document.body) : panel;
}

function Fixture({
  menu,
  tooltip = false,
  realMenu = false,
}: {
  menu?: 'inline' | 'portal';
  tooltip?: boolean;
  realMenu?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCanvasFocusEscape(ref);
  return (
    <>
      <div ref={ref} data-canvas-root tabIndex={-1}>
        <div
          className="react-flow__node"
          data-id="media"
          onKeyDown={flowKeyDown}
        >
          <div onKeyDown={handleCanvasFocusEscape}>
            <Button
              aria-label="Node content"
              title={tooltip ? 'Node tooltip' : undefined}
            >
              Play
            </Button>
            <input aria-label="Editor" />
            <button
              aria-label="Child menu"
              onKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            />
          </div>
          {createPortal(
            <div
              className="node-floating-toolbar"
              onKeyDown={handleCanvasFocusEscape}
            >
              <Button
                aria-label="Toolbar field"
                title={tooltip ? 'Toolbar tooltip' : undefined}
              >
                Action
              </Button>
              {menu && <Menu portal={menu === 'portal'} />}
              {realMenu && (
                <DropdownMenu trigger={<Button>Open real menu</Button>}>
                  <DropdownMenuItem title="Menu tooltip">
                    Real menu item
                  </DropdownMenuItem>
                </DropdownMenu>
              )}
            </div>,
            document.body,
          )}
        </div>
        <input aria-label="Other canvas control" />
      </div>
      <input aria-label="Outside" />
    </>
  );
}

describe('canvas Escape focus handoff', () => {
  let host: HTMLDivElement;
  let root: Root;
  let canvas: HTMLElement;
  let content: HTMLElement;
  function element(selector: string) {
    const result = document.querySelector<HTMLElement>(selector);
    if (!result) throw new Error(`Missing fixture element: ${selector}`);
    return result;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    attention.isCanvasEngaged = true;
    store.nodes = [{ id: 'media', selected: true }];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Fixture />));
    canvas = element('[data-canvas-root]');
    content = element('[aria-label="Node content"]');
    store.canvasWrapper = canvas;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.canvasWrapper = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function escape(target: HTMLElement, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => target.dispatchEvent(event));
    return event;
  }

  it('first focuses the canvas before RF can deselect, then clears selection on the next press', () => {
    content.focus();
    expect(escape(content).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(store.selectNodes).not.toHaveBeenCalled();
    expect(flowKeyDown).not.toHaveBeenCalled();
    escape(canvas, { repeat: true });
    expect(store.selectNodes).not.toHaveBeenCalled();
    escape(canvas);
    expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('hands focus back from a portalled toolbar without clearing selection', () => {
    const field = element('[aria-label="Toolbar field"]');
    expect(host.contains(field)).toBe(false);
    field.focus();
    escape(field);
    expect(document.activeElement).toBe(canvas);
    expect(store.selectNodes).not.toHaveBeenCalled();
    expect(flowKeyDown).not.toHaveBeenCalled();
    escape(canvas);
    expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('clears pointer selection when focus remains on body', () => {
    content.focus();
    content.blur();
    expect(document.activeElement).toBe(document.body);
    expect(escape(document.body).defaultPrevented).toBe(true);
    expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
    expect(document.activeElement).toBe(canvas);
  });

  it.each(['Node content', 'Toolbar field'])(
    'dismisses a visible tooltip and exits %s focus on the same Escape, then deselects',
    async (label) => {
      act(() => root.render(<Fixture tooltip />));
      const trigger = element(`[aria-label="${label}"]`);
      await act(async () => trigger.focus());
      const tooltip = element('[role="tooltip"]');
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
      expect(document.activeElement).toBe(trigger);

      escape(trigger);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(document.activeElement).toBe(canvas);
      expect(store.selectNodes).not.toHaveBeenCalled();
      expect(flowKeyDown).not.toHaveBeenCalled();

      escape(canvas);
      expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
    },
  );

  it('closes a real menu containing a visible tooltip without leaking Escape to the canvas', async () => {
    act(() => root.render(<Fixture realMenu />));
    const trigger = element('[aria-expanded="false"]');
    act(() => trigger.click());
    const item = element('[role="menuitem"]');
    await act(async () => item.focus());
    const tooltip = element('[role="tooltip"]');
    expect(item.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(document.activeElement).toBe(item);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    escape(item);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).not.toBe(canvas);
    expect(store.selectNodes).not.toHaveBeenCalled();
    expect(flowKeyDown).not.toHaveBeenCalled();
  });

  it('does not clear body-targeted selection after attention moves elsewhere', () => {
    attention.isCanvasEngaged = false;
    expect(escape(document.body).defaultPrevented).toBe(false);
    expect(store.selectNodes).not.toHaveBeenCalled();
  });

  it('does not clear body-targeted selection behind a modal', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);
    try {
      expect(escape(document.body).defaultPrevented).toBe(false);
      expect(store.selectNodes).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
  });

  it('ignores body Escape when this canvas is no longer active', () => {
    store.canvasWrapper = null;
    expect(escape(document.body).defaultPrevented).toBe(false);
    expect(store.selectNodes).not.toHaveBeenCalled();
  });

  it('clears selection from an idle pane but not its form controls', () => {
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    canvas.append(pane);
    expect(escape(pane).defaultPrevented).toBe(true);
    expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
  });

  it.each(['Outside', 'Other canvas control'])(
    'does not steal focus from %s',
    (label) => {
      const field = element(`[aria-label="${label}"]`);
      field.focus();
      expect(escape(field).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(field);
      expect(store.selectNodes).not.toHaveBeenCalled();
    },
  );

  it.each(['preventDefault', 'stopPropagation'] as const)(
    'respects a child handler using %s',
    (method) => {
      content.focus();
      content.addEventListener('keydown', (event) => event[method](), {
        once: true,
      });
      escape(content);
      expect(document.activeElement).toBe(content);
      expect(store.selectNodes).not.toHaveBeenCalled();
      expect(flowKeyDown).not.toHaveBeenCalled();
    },
  );

  it.each(['inline', 'portal'] as const)(
    'lets an actual document-bubble %s menu dismiss without leaking to RF',
    (menu) => {
      act(() => root.render(<Fixture menu={menu} />));
      const item = element('[aria-label="Menu item"]');
      item.focus();
      expect(escape(item).defaultPrevented).toBe(false);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).not.toBe(canvas);
      expect(store.selectNodes).not.toHaveBeenCalled();
      expect(flowKeyDown).not.toHaveBeenCalled();
    },
  );

  it('dismisses a menu first even when focus stays on its toolbar trigger', () => {
    act(() => root.render(<Fixture menu="portal" />));
    const field = element('[aria-label="Toolbar field"]');
    field.focus();
    escape(field);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(store.selectNodes).not.toHaveBeenCalled();
    escape(field);
    expect(document.activeElement).toBe(canvas);
    expect(store.selectNodes).not.toHaveBeenCalled();
    escape(canvas);
    expect(store.selectNodes).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('respects React child menu dismissal', () => {
    const child = element('[aria-label="Child menu"]');
    child.focus();
    escape(child);
    expect(document.activeElement).toBe(child);
    expect(flowKeyDown).not.toHaveBeenCalled();
    expect(store.selectNodes).not.toHaveBeenCalled();
  });

  it.each(['Node content', 'Toolbar field'])(
    'lets window-capture gesture cancellation win for %s',
    (label) => {
      const cancel = vi.fn((event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
      });
      window.addEventListener('keydown', cancel, true);
      try {
        const target = element(`[aria-label="${label}"]`);
        target.focus();
        escape(target);
        expect(cancel).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(target);
        expect(flowKeyDown).not.toHaveBeenCalled();
        expect(store.selectNodes).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', cancel, true);
      }
    },
  );

  it.each([
    { isComposing: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
  ])('ignores modified/composing Escape %j', (init) => {
    content.focus();
    expect(escape(content, init).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(content);
    expect(store.selectNodes).not.toHaveBeenCalled();
    expect(flowKeyDown).not.toHaveBeenCalled();
  });

  it('does not steal fullscreen Escape or clear selection', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      'fullscreenElement',
    );
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: content,
    });
    try {
      content.focus();
      expect(escape(content).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(content);
      expect(store.selectNodes).not.toHaveBeenCalled();
      expect(flowKeyDown).not.toHaveBeenCalled();
    } finally {
      if (descriptor)
        Object.defineProperty(document, 'fullscreenElement', descriptor);
      else Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });

  it('hands back unclaimed editor Escape', () => {
    const editor = element('[aria-label="Editor"]');
    editor.focus();
    escape(editor);
    expect(document.activeElement).toBe(canvas);
    expect(store.selectNodes).not.toHaveBeenCalled();
  });

  it('leaves non-Escape keys to RF and native propagation', () => {
    content.focus();
    expect(escape(content, { key: 'ArrowLeft' }).defaultPrevented).toBe(false);
    expect(flowKeyDown).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(content);
  });

  it('ignores unselected nodes and another canvas toolbar', () => {
    store.nodes = [{ id: 'media', selected: false }];
    content.focus();
    escape(content);
    expect(document.activeElement).toBe(content);
    store.canvasWrapper = null;
    const field = element('[aria-label="Toolbar field"]');
    field.focus();
    escape(field);
    expect(document.activeElement).toBe(field);
  });

  it('removes its listener on unmount', () => {
    act(() => root.render(null));
    document.body.append(canvas);
    try {
      content.focus();
      escape(content);
      expect(document.activeElement).toBe(content);
      expect(store.selectNodes).not.toHaveBeenCalled();
    } finally {
      canvas.remove();
    }
  });
});
