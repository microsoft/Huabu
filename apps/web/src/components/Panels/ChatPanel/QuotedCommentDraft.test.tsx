// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { QuotedCommentDraft } from './QuotedCommentDraft';

let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn();
const onRemove = vi.fn();
const onKeyboardEditEnd = vi.fn();

beforeEach(async () => {
  await i18n.changeLanguage('en');
  onChange.mockClear();
  onRemove.mockClear();
  onKeyboardEditEnd.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  function Harness() {
    const [comment, setComment] = useState({
      quote: 'Quoted passage',
      contextBefore: 'Hidden before',
      contextAfter: 'Hidden after',
      comment: 'Original comment',
    });
    return (
      <QuotedCommentDraft
        comment={comment}
        disabled={false}
        onChange={(value) => {
          onChange(value);
          setComment((current) => ({ ...current, comment: value }));
        }}
        onRemove={onRemove}
        onKeyboardEditEnd={onKeyboardEditEnd}
      />
    );
  }
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function input() {
  const element = host.querySelector('textarea');
  if (!element) throw new Error('Missing comment editor');
  return element;
}

function begin() {
  act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')
      ?.click(),
  );
}

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(value: string, isComposing = false, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    isComposing,
    shiftKey,
  });
  act(() => input().dispatchEvent(event));
  return event;
}

describe('quoted comment draft presentation', () => {
  it('shows wrapping comment text without persistent fields, context or an outer border', () => {
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[aria-label="Edit comment"]')?.textContent).toBe(
      'Original comment',
    );
    expect(host.textContent).not.toContain('Hidden before');
    expect(host.textContent).not.toContain('Hidden after');
    expect(
      host.querySelector('[data-quoted-comment]')?.classList.contains('border'),
    ).toBe(false);
  });

  it('focuses the editor on demand and finishes with Enter without duplicate blur updates', () => {
    begin();
    const editor = input();
    expect(document.activeElement).toBe(editor);
    type(' Updated comment ');
    onChange.mockClear();
    expect(key('Enter').defaultPrevented).toBe(true);
    act(() =>
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Updated comment');
    expect(onKeyboardEditEnd).toHaveBeenCalledOnce();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[aria-label="Edit comment"]')?.textContent).toBe(
      'Updated comment',
    );
  });

  it('finishes editing on blur', () => {
    begin();
    type('Saved on blur');
    act(() => input().blur());
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[aria-label="Edit comment"]')?.textContent).toBe(
      'Saved on blur',
    );
  });

  it('restores the pre-edit comment on Escape', () => {
    begin();
    type('Unfinished edit');
    key('Escape');
    expect(onChange).toHaveBeenLastCalledWith('Original comment');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[aria-label="Edit comment"]')?.textContent).toBe(
      'Original comment',
    );
  });

  it('keeps an empty edit open with visible validation feedback', () => {
    begin();
    type(' ');
    key('Enter');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter a comment or remove this quote.',
    );
    expect(onKeyboardEditEnd).not.toHaveBeenCalled();
    key('Escape');
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('does not finish editing during IME composition', () => {
    begin();
    type('你好');
    expect(key('Enter', true).defaultPrevented).toBe(true);
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(onKeyboardEditEnd).not.toHaveBeenCalled();
  });

  it('preserves multiline text across edits and allows Shift+Enter without finishing', () => {
    begin();
    type('First line\nSecond line');
    expect(key('Enter', false, true).defaultPrevented).toBe(false);
    expect(input().value).toBe('First line\nSecond line');
    expect(onKeyboardEditEnd).not.toHaveBeenCalled();
    key('Enter');
    begin();
    expect(input().value).toBe('First line\nSecond line');
    type('First line\nSecond line!');
    key('Enter');
    expect(host.querySelector('[aria-label="Edit comment"]')?.textContent).toBe(
      'First line\nSecond line!',
    );
  });

  it('overlays a circular remove action revealed on hover or keyboard focus', () => {
    const remove = host.querySelector<HTMLButtonElement>(
      '[aria-label="Remove quoted comment"]',
    );
    expect(remove?.classList.contains('rounded-full')).toBe(true);
    expect(remove?.classList.contains('bg-hover')).toBe(true);
    const overlay = remove?.closest('.absolute');
    expect(overlay?.classList.contains('opacity-0')).toBe(true);
    expect(
      overlay?.classList.contains('group-hover/quoted-comment:opacity-100'),
    ).toBe(true);
    expect(
      overlay?.classList.contains(
        'group-focus-within/quoted-comment:opacity-100',
      ),
    ).toBe(true);
    expect(
      overlay?.classList.contains('[@media(hover:none)]:opacity-100'),
    ).toBe(true);
    act(() => remove?.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
