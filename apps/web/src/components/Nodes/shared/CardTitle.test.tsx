// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardTitle, type CardTitleEditor } from './CardTitle';

vi.mock('@/components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let editor: CardTitleEditor;
const open = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const rects = [new DOMRect(0, 0, 100, 20), new DOMRect(0, 24, 50, 20)];
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    Object.assign(rects, { item: (index: number) => rects[index] ?? null }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  editor = {
    active: false,
    draft: 'Original title',
    saving: false,
    maxLength: 120,
    onStart: vi.fn(),
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(selected = true, editable = true) {
  act(() =>
    root.render(
      <div onDoubleClick={open}>
        <CardTitle
          title="Original title"
          selected={selected}
          renameLabel="Rename node"
          editor={editable ? editor : undefined}
        />
      </div>,
    ),
  );
}

describe('shared card title gestures', () => {
  function click(detail: number) {
    act(() => {
      const button = host.querySelector('button');
      button?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    });
  }

  function doubleClick(clientX = 10, clientY = 10) {
    act(() =>
      host.querySelector('button')?.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          detail: 2,
          clientX,
          clientY,
        }),
      ),
    );
  }

  it('opens an initially unselected card even when the first click selects it', () => {
    render(false);
    const button = host.querySelector('button');
    expect(button?.tabIndex).toBe(-1);
    expect(button?.classList.contains('nodrag')).toBe(false);
    click(1);
    render(true);
    expect(host.querySelector('button')).toBe(button);
    expect(button?.tabIndex).toBe(0);
    click(2);
    doubleClick();
    expect(open).toHaveBeenCalledOnce();
    expect(editor.onStart).not.toHaveBeenCalled();
  });

  it('renames only on a double-click over text in an already-selected card', () => {
    render();
    click(1);
    expect(editor.onStart).not.toHaveBeenCalled();
    click(2);
    doubleClick();
    expect(editor.onStart).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    [120, 10],
    [75, 30],
    [10, 22],
  ])('opens from title whitespace at (%s, %s)', (x, y) => {
    render();
    click(1);
    click(2);
    doubleClick(x, y);
    expect(open).toHaveBeenCalledOnce();
    expect(editor.onStart).not.toHaveBeenCalled();
  });

  it('supports keyboard activation of a selected title', () => {
    render();
    act(() => host.querySelector('button')?.click());
    expect(editor.onStart).toHaveBeenCalledOnce();
  });

  it('keeps double-click text selection inside the active editor', () => {
    editor.active = true;
    render();
    act(() =>
      host
        .querySelector('textarea')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('focuses and selects the draft without changing its typography', () => {
    editor.active = true;
    render();
    const input = host.querySelector('textarea');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe(editor.draft.length);
    expect(input?.maxLength).toBe(120);
    expect(input?.style.font).toBe('inherit');
    expect(input?.classList.contains('nodrag')).toBe(true);
    expect(input?.classList.contains('nopan')).toBe(true);
    expect(input?.getAttribute('rows')).toBe('1');
    expect(input?.classList.contains('wrap-anywhere')).toBe(true);
    expect(input?.classList.contains('resize-none')).toBe(true);
  });

  it('preserves the display title as an inaccessible sizing placeholder while editing', () => {
    editor.active = true;
    render();
    const input = host.querySelector('textarea');
    if (!input) throw new Error('Title editor is unavailable');
    const placeholder = host.querySelector('button');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder?.tabIndex).toBe(-1);
    expect(placeholder?.classList.contains('invisible')).toBe(true);
    expect(input.classList.contains('absolute')).toBe(true);
    expect(input.classList.contains('overflow-y-auto')).toBe(true);
    expect(input.classList.contains('nowheel')).toBe(true);
    expect(input.parentElement?.classList.contains('flex-1')).toBe(true);
    editor.draft = 'A long title that wraps across multiple lines';
    render();
    expect(placeholder?.textContent).toBe('Original title');
    expect(input.style.height).toBe('');
    editor.draft = 'Short';
    render();
    expect(placeholder?.textContent).toBe('Original title');
    expect(input.style.height).toBe('');
  });

  it('keeps pasted line breaks out of the title as the single-line input did', () => {
    editor.active = true;
    render();
    const input = host.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (!input || !setter) throw new Error('Title editor is unavailable');
    act(() => {
      setter.call(input, 'First\nSecond');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(editor.onChange).toHaveBeenCalledWith('FirstSecond');
  });

  it('ignores IME Enter and delegates Enter, blur, and Escape to the owner', () => {
    editor.active = true;
    render();
    const input = host.querySelector('textarea');
    const key = (options: KeyboardEventInit) =>
      act(() =>
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, ...options }),
        ),
      );
    key({ key: 'Enter', isComposing: true });
    key({ key: 'Enter', keyCode: 229 });
    expect(editor.onCommit).not.toHaveBeenCalled();
    key({ key: 'Enter' });
    expect(editor.onCommit).toHaveBeenCalledOnce();
    key({ key: 'Escape' });
    expect(editor.onCancel).toHaveBeenCalledOnce();
    act(() => input?.blur());
    expect(editor.onCommit).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight save read-only and does not cancel it', () => {
    editor.active = true;
    editor.saving = true;
    render();
    const input = host.querySelector('textarea');
    expect(input?.readOnly).toBe(true);
    act(() =>
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(editor.onCancel).not.toHaveBeenCalled();
  });

  it('renders a non-editable title without a button or input', () => {
    render(true, false);
    expect(host.textContent).toBe('Original title');
    expect(host.querySelector('button, input, textarea')).toBeNull();
  });
});
