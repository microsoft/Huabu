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
  it('selects first and starts editing only on a subsequent title click', () => {
    render(false);
    act(() =>
      host
        .querySelector('span')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    render(true);
    const button = host.querySelector('button');
    act(() =>
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      ),
    );
    expect(editor.onStart).not.toHaveBeenCalled();
    act(() => {
      button?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(editor.onStart).toHaveBeenCalledOnce();
  });

  it('supports keyboard activation and prevents title double-click navigation', () => {
    render();
    act(() => host.querySelector('button')?.click());
    expect(editor.onStart).toHaveBeenCalledOnce();
    act(() =>
      host
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('focuses and selects the draft without changing its typography', () => {
    editor.active = true;
    render();
    const input = host.querySelector('input');
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe(editor.draft.length);
    expect(input?.maxLength).toBe(120);
    expect(input?.style.font).toBe('inherit');
    expect(input?.classList.contains('nodrag')).toBe(true);
    expect(input?.classList.contains('nopan')).toBe(true);
  });

  it('ignores IME Enter and delegates Enter, blur, and Escape to the owner', () => {
    editor.active = true;
    render();
    const input = host.querySelector('input');
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
    const input = host.querySelector('input');
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
    expect(host.querySelector('button, input')).toBeNull();
  });
});
