// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { WorkingDirectoryOverride } from './WorkingDirectoryOverride';

let container: HTMLDivElement;
let root: Root;

async function render(
  props: React.ComponentProps<typeof WorkingDirectoryOverride>,
) {
  await act(async () => root.render(<WorkingDirectoryOverride {...props} />));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('WorkingDirectoryOverride', () => {
  it('shows Profile inheritance and updates it without persisting a copy', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/first',
      editable: true,
      saving: false,
      onSave,
    });

    const input = container.querySelector('input')!;
    expect(input.placeholder).toBe('/profiles/first');
    expect(container.textContent).toContain(
      'Inheriting Profile directory: /profiles/first',
    );

    await render({
      profileWorkingDirPath: '/profiles/second',
      editable: true,
      saving: false,
      onSave,
    });
    expect(container.querySelector('input')?.value).toBe('');
    expect(container.querySelector('input')?.placeholder).toBe(
      '/profiles/second',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves an explicit override across Profile changes and clears to null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/first',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    await render({
      profileWorkingDirPath: '/profiles/second',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    const input = container.querySelector('input')!;
    expect(input.value).toBe('/node/work');

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('keeps a locked explicit override visible but hides locked inheritance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/default',
      workingDirPath: '/node/work',
      editable: false,
      saving: false,
      onSave,
    });
    expect(container.textContent).toContain('/node/work');
    expect(container.querySelector('input')).toBeNull();

    await render({
      profileWorkingDirPath: '/profiles/default',
      editable: false,
      saving: false,
      onSave,
    });
    expect(container.textContent).toBe('');
  });

  it('surfaces server validation errors without replacing the draft', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Must be absolute'));
    await render({
      profileWorkingDirPath: '/profiles/default',
      editable: true,
      saving: false,
      onSave,
    });
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'relative/path');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Must be absolute',
    );
    expect(input.value).toBe('relative/path');
  });
});
