// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLink,
  DropdownMenuSubmenu,
} from './DropdownMenu';
import { TextInput } from './TextInput';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(content: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(content));
}

function getElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

async function press(element: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('DropdownMenu keyboard contract', () => {
  it('restores focus after a controlled action closes the menu', async () => {
    function Menu() {
      const [open, setOpen] = useState(false);
      return (
        <DropdownMenu
          open={open}
          onOpenChange={setOpen}
          trigger={<Button data-testid="trigger">Actions</Button>}
        >
          <DropdownMenuItem onClick={() => setOpen(false)}>
            Apply
          </DropdownMenuItem>
        </DropdownMenu>
      );
    }
    await mount(<Menu />);
    await click(getElement('[data-testid="trigger"]'));
    await click(getElement('[role="menuitem"]'));
    await nextFrame();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(getElement('[data-testid="trigger"]'));
  });

  it('does not steal focus from a dialog opened by an action', async () => {
    function Menu() {
      const [open, setOpen] = useState(false);
      const [dialog, setDialog] = useState(false);
      return (
        <>
          <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            trigger={<Button>Actions</Button>}
          >
            <DropdownMenuItem
              onClick={() => {
                setOpen(false);
                setDialog(true);
              }}
            >
              Edit
            </DropdownMenuItem>
          </DropdownMenu>
          {dialog && (
            <div role="dialog">
              <TextInput autoFocus aria-label="Name" />
            </div>
          )}
        </>
      );
    }
    await mount(<Menu />);
    await click(getElement('button'));
    await click(getElement('[role="menuitem"]'));
    await nextFrame();
    expect(document.activeElement).toBe(getElement('input'));
  });

  it('does not restore focus after an outside press on a nonfocusable target', async () => {
    await mount(
      <>
        <DropdownMenu trigger={<Button>Actions</Button>}>
          <DropdownMenuItem>Apply</DropdownMenuItem>
        </DropdownMenu>
        <div data-testid="outside">Canvas</div>
      </>,
    );
    await click(getElement('button'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () =>
      getElement('[data-testid="outside"]').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      ),
    );
    await nextFrame();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('navigates checkbox and radio items and exposes their checked state', async () => {
    await mount(
      <DropdownMenu trigger={<Button>Filters</Button>}>
        <DropdownMenuItem role="menuitemcheckbox" aria-checked>
          Selected filter
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemcheckbox" aria-checked={false} disabled>
          Disabled filter
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemradio" aria-checked={false}>
          Other choice
        </DropdownMenuItem>
      </DropdownMenu>,
    );
    await click(getElement('button'));
    const selected = getElement('[role="menuitemcheckbox"]');
    expect(document.activeElement).toBe(selected);
    expect(selected.getAttribute('aria-checked')).toBe('true');
    await press(selected, 'ArrowDown');
    expect(document.activeElement).toBe(getElement('[role="menuitemradio"]'));
  });

  it('labels the menu, focuses its first enabled item, and navigates buttons and links', async () => {
    await mount(
      <MemoryRouter>
        <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
          <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
          <DropdownMenuItem data-testid="first">First</DropdownMenuItem>
          <div role="separator" />
          <DropdownMenuLink to="/spaces" data-testid="last">
            Spaces
          </DropdownMenuLink>
        </DropdownMenu>
      </MemoryRouter>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    await click(trigger);
    const menu = getElement('[role="menu"]');
    const first = getElement('[data-testid="first"]');
    const last = getElement('[data-testid="last"]');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('aria-labelledby')).toBe(trigger.id);
    expect(document.activeElement).toBe(first);
    expect(last.tagName).toBe('A');
    expect(last.getAttribute('href')).toBe('/spaces');
    await press(first, 'ArrowDown');
    expect(document.activeElement).toBe(last);
    await press(last, 'ArrowDown');
    expect(document.activeElement).toBe(first);
    await press(first, 'ArrowUp');
    expect(document.activeElement).toBe(last);
    await press(last, 'Home');
    expect(document.activeElement).toBe(first);
    await press(first, 'End');
    expect(document.activeElement).toBe(last);
  });

  it.each(['ArrowDown', 'ArrowUp'])(
    'opens from %s at the expected edge',
    async (key) => {
      const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
      await mount(
        <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
          <DropdownMenuItem data-testid="first">First</DropdownMenuItem>
          <DropdownMenuItem data-testid="last">Last</DropdownMenuItem>
        </DropdownMenu>,
      );
      const trigger = getElement('[data-testid="trigger"]');
      act(() => trigger.focus());
      await press(trigger, key);
      const item = getElement(
        key === 'ArrowUp' ? '[data-testid="last"]' : '[data-testid="first"]',
      );
      expect(document.activeElement).toBe(item);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scroll.mock.instances.at(-1)).toBe(item);
    },
  );

  it('respects a trigger handler that consumes an arrow key', async () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) =>
      event.preventDefault(),
    );
    await mount(
      <DropdownMenu
        trigger={
          <Button data-testid="trigger" onKeyDown={onKeyDown}>
            Actions
          </Button>
        }
      >
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenu>,
    );
    await press(getElement('[data-testid="trigger"]'), 'ArrowDown');
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes on Escape and restores trigger focus', async () => {
    await mount(
      <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenu>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    await click(trigger);
    await press(getElement('[role="menuitem"]'), 'Escape');
    await nextFrame();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses on Tab without preventing native tab traversal', async () => {
    await mount(
      <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenu>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    await click(trigger);
    const event = await press(getElement('[role="menuitem"]'), 'Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps outside-press focus outside the menu', async () => {
    await mount(
      <>
        <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
          <DropdownMenuItem>First</DropdownMenuItem>
        </DropdownMenu>
        <Button data-testid="outside">Outside</Button>
      </>,
    );
    await click(getElement('[data-testid="trigger"]'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const outside = getElement('[data-testid="outside"]');
    act(() => {
      outside.focus();
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await nextFrame();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('opens a submenu with ArrowRight and returns with ArrowLeft or Escape', async () => {
    await mount(
      <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
        <DropdownMenuSubmenu label="More">
          <DropdownMenuItem data-testid="child">Child</DropdownMenuItem>
        </DropdownMenuSubmenu>
        <DropdownMenuItem data-testid="sibling">Sibling</DropdownMenuItem>
      </DropdownMenu>,
    );
    await click(getElement('[data-testid="trigger"]'));
    const submenuTrigger = getElement(
      '[role="menuitem"][aria-haspopup="menu"]',
    );
    await press(submenuTrigger, 'ArrowRight');
    const child = getElement('[data-testid="child"]');
    expect(document.activeElement).toBe(child);
    await press(child, 'ArrowDown');
    expect(document.activeElement).toBe(child);
    await press(child, 'ArrowLeft');
    await nextFrame();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.activeElement).toBe(submenuTrigger);
    await press(submenuTrigger, 'ArrowRight');
    await press(getElement('[data-testid="child"]'), 'Escape');
    await nextFrame();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.activeElement).toBe(submenuTrigger);
  });

  it.each([
    ['ArrowDown', 'last'],
    ['ArrowUp', 'first'],
  ])(
    'keeps %s on a submenu trigger in the parent menu',
    async (key, target) => {
      await mount(
        <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
          <DropdownMenuItem data-testid="first">First</DropdownMenuItem>
          <DropdownMenuSubmenu label="More">
            <DropdownMenuItem>Child</DropdownMenuItem>
          </DropdownMenuSubmenu>
          <DropdownMenuItem data-testid="last">Last</DropdownMenuItem>
        </DropdownMenu>,
      );
      await click(getElement('[data-testid="trigger"]'));
      await press(getElement('[data-testid="first"]'), 'ArrowDown');
      const submenuTrigger = getElement(
        '[role="menuitem"][aria-haspopup="menu"]',
      );
      expect(document.activeElement).toBe(submenuTrigger);
      await press(submenuTrigger, key);
      expect(document.activeElement).toBe(
        getElement(`[data-testid="${target}"]`),
      );
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    },
  );

  it('preserves hover focus and supports entering the open submenu with ArrowRight', async () => {
    await mount(
      <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
        <DropdownMenuItem data-testid="first">First</DropdownMenuItem>
        <DropdownMenuSubmenu label="More">
          <DropdownMenuItem data-testid="child">Child</DropdownMenuItem>
        </DropdownMenuSubmenu>
      </DropdownMenu>,
    );
    await click(getElement('[data-testid="trigger"]'));
    const first = getElement('[data-testid="first"]');
    const submenuTrigger = getElement(
      '[role="menuitem"][aria-haspopup="menu"]',
    );
    await act(async () =>
      submenuTrigger.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      ),
    );
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
    expect(document.activeElement).toBe(first);
    await press(first, 'ArrowDown');
    expect(document.activeElement).toBe(submenuTrigger);
    await press(submenuTrigger, 'ArrowRight');
    expect(document.activeElement).toBe(getElement('[data-testid="child"]'));
  });

  it('enters a hovered submenu on click instead of toggling it closed', async () => {
    await mount(
      <DropdownMenu trigger={<Button>Actions</Button>}>
        <DropdownMenuSubmenu label="More">
          <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
          <DropdownMenuItem data-testid="child">Child</DropdownMenuItem>
        </DropdownMenuSubmenu>
      </DropdownMenu>,
    );
    await click(getElement('button'));
    const submenuTrigger = getElement('[role="menuitem"][aria-haspopup]');
    await act(async () =>
      submenuTrigger.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true }),
      ),
    );
    await click(submenuTrigger);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
    expect(document.activeElement).toBe(getElement('[data-testid="child"]'));
  });

  it('dismisses the whole menu chain when Tab leaves a submenu', async () => {
    await mount(
      <DropdownMenu trigger={<Button data-testid="trigger">Actions</Button>}>
        <DropdownMenuSubmenu label="More">
          <DropdownMenuItem data-testid="child">Child</DropdownMenuItem>
        </DropdownMenuSubmenu>
      </DropdownMenu>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    await click(trigger);
    await press(
      getElement('[role="menuitem"][aria-haspopup="menu"]'),
      'ArrowRight',
    );
    const event = await press(getElement('[data-testid="child"]'), 'Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('preserves text editing and custom initial focus in dialog panels', async () => {
    let input: HTMLInputElement | null = null;
    await mount(
      <DropdownMenu
        contentRole="dialog"
        onOpenAutoFocus={() => input?.focus()}
        trigger={<Button data-testid="trigger">Dimensions</Button>}
      >
        <TextInput
          ref={(node) => {
            input = node;
          }}
          aria-label="Width"
          defaultValue="120"
        />
      </DropdownMenu>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    await click(trigger);
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const field = getElement('input');
    expect(document.activeElement).toBe(field);
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
      expect((await press(field, key)).defaultPrevented).toBe(false);
    }
  });

  it('does not add a second menu or duplicate custom keyboard navigation', async () => {
    const onKeyDown = vi.fn();
    await mount(
      <DropdownMenu
        contentRole="presentation"
        trigger={<Button data-testid="trigger">Custom menu</Button>}
      >
        <div role="menu" tabIndex={-1} onKeyDown={onKeyDown}>
          <DropdownMenuItem>First</DropdownMenuItem>
        </div>
      </DropdownMenu>,
    );
    await click(getElement('[data-testid="trigger"]'));
    await press(getElement('[role="menuitem"]'), 'ArrowDown');
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it('preserves a custom trigger relationship while its context menu is closed', async () => {
    await mount(
      <DropdownMenu
        contentRole="presentation"
        trigger={
          <Button
            role="tab"
            id="preview-tab"
            aria-controls="preview-panel"
            data-testid="trigger"
          >
            Preview
          </Button>
        }
      >
        <div role="menu" tabIndex={-1}>
          <DropdownMenuItem>Close</DropdownMenuItem>
        </div>
      </DropdownMenu>,
    );
    const trigger = getElement('[data-testid="trigger"]');
    expect(trigger.id).toBe('preview-tab');
    expect(trigger.getAttribute('aria-controls')).toBe('preview-panel');
    await click(trigger);
    expect(trigger.getAttribute('aria-controls')).toBe('preview-panel');
  });
});
