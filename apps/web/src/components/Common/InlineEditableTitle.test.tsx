// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineEditableTitle } from './InlineEditableTitle';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(active = false, disabled = false) {
  const editor = {
    active,
    disabled,
    draft: 'Original title',
    maxLength: 120,
    onStart: vi.fn(),
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
  act(() =>
    root.render(
      <InlineEditableTitle
        title="Original title"
        ariaLabel="Rename"
        placeholder="Untitled"
        editor={editor}
      />,
    ),
  );
  return editor;
}

function key(input: HTMLInputElement, value: string, isComposing = false) {
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

function control<K extends 'input' | 'button'>(
  tag: K,
): HTMLElementTagNameMap[K] {
  const element = container.querySelector(tag);
  if (!element) throw new Error(`Missing ${tag}`);
  return element;
}

describe('InlineEditableTitle', () => {
  it('shares typography and spacing across display and editing and reuses TextInput focus styling', () => {
    const editor = render();
    const button = control('button');
    act(() => button.click());
    expect(editor.onStart).toHaveBeenCalledOnce();
    const displayClasses = button.classList;
    render(true);
    const input = control('input');
    for (const token of [
      'text-sm',
      'font-normal',
      'border-solid',
      'px-1',
      'py-0.5',
      'min-w-0',
      'max-w-full',
    ]) {
      expect(displayClasses.contains(token)).toBe(true);
      expect(input.classList.contains(token)).toBe(true);
    }
    expect(input.classList.contains('focus:ring-info-light')).toBe(true);
    expect(input.classList.contains('border-transparent')).toBe(false);
    expect(input.maxLength).toBe(120);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('commits only once for Enter followed by blur', () => {
    const editor = render(true);
    const input = control('input');
    key(input, 'Enter');
    act(() => input.blur());
    expect(editor.onCommit).toHaveBeenCalledOnce();
  });

  it('commits on blur without requiring Enter', () => {
    const editor = render(true);
    act(() => control('input').blur());
    expect(editor.onCommit).toHaveBeenCalledOnce();
  });

  it('cancels without committing on blur or bubbling Escape to the panel', () => {
    const editor = render(true);
    const input = control('input');
    const parentKey = vi.fn();
    window.addEventListener('keydown', parentKey);
    key(input, 'Escape');
    act(() => input.blur());
    window.removeEventListener('keydown', parentKey);
    expect(editor.onCancel).toHaveBeenCalledOnce();
    expect(editor.onCommit).not.toHaveBeenCalled();
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('does not save or cancel during IME composition', () => {
    const editor = render(true);
    const input = control('input');
    key(input, 'Enter', true);
    key(input, 'Escape', true);
    expect(editor.onCommit).not.toHaveBeenCalled();
    expect(editor.onCancel).not.toHaveBeenCalled();
    key(input, 'Enter');
    expect(editor.onCommit).toHaveBeenCalledOnce();
  });

  it('supports disabled editing and a non-interactive placeholder title', () => {
    const editor = render(false, true);
    act(() => control('button').click());
    expect(editor.onStart).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <InlineEditableTitle
          title=""
          placeholder="Untitled"
          ariaLabel="Rename"
        />,
      ),
    );
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('Untitled');
  });
});
