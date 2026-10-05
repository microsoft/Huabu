// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { i18n } from '@/i18n';

import { WorkingDirectoryOverride } from './WorkingDirectoryOverride';

let container: HTMLDivElement;
let root: Root;

async function render(
  props: React.ComponentProps<typeof WorkingDirectoryOverride>,
) {
  await act(async () => root.render(<WorkingDirectoryOverride {...props} />));
}

async function openPopover() {
  const trigger = container.querySelector<HTMLButtonElement>('button');
  assert(trigger);
  await act(async () => trigger.click());
}

function nodeOverrideInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Node override"]',
  );
  assert(input);
  return input;
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
      profileAlias: 'First Profile',
      profileWorkingDirPath: '/profiles/first',
      editable: true,
      saving: false,
      onSave,
    });
    expect(document.body.textContent).not.toContain(
      'Inheriting Profile directory',
    );
    await openPopover();

    const input = nodeOverrideInput();
    expect(input.placeholder).toBe('/profiles/first');
    expect(document.body.textContent).toContain(
      'Inheriting Profile directory: /profiles/first',
    );
    expect(document.body.textContent).toContain('First Profile');

    await render({
      profileAlias: 'Second Profile',
      profileWorkingDirPath: '/profiles/second',
      editable: true,
      saving: false,
      onSave,
    });
    const updatedInput = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Node override"]',
    );
    expect(updatedInput?.value).toBe('');
    expect(updatedInput?.placeholder).toBe('/profiles/second');
    expect(document.body.textContent).toContain('Second Profile');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves an explicit override across Profile changes and clears to null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileAlias: 'First Profile',
      profileWorkingDirPath: '/profiles/first',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    await openPopover();
    await render({
      profileAlias: 'Second Profile',
      profileWorkingDirPath: '/profiles/second',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    const input = nodeOverrideInput();
    expect(input.value).toBe('/node/work');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      assert(valueSetter);
      valueSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('keeps a locked explicit override visible but hides locked inheritance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileAlias: 'Default Profile',
      profileWorkingDirPath: '/profiles/default',
      workingDirPath: '/node/work',
      editable: false,
      saving: false,
      onSave,
    });
    expect(container.textContent).not.toContain('/node/work');
    await openPopover();
    expect(document.body.textContent).toContain('/node/work');
    expect(document.body.querySelector('input')).toBeNull();

    await render({
      profileAlias: 'Default Profile',
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
      profileAlias: 'Default Profile',
      profileWorkingDirPath: '/profiles/default',
      editable: true,
      saving: false,
      onSave,
    });
    await openPopover();
    const input = nodeOverrideInput();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      assert(valueSetter);
      valueSetter.call(input, 'relative/path');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Must be absolute',
    );
    expect(input.value).toBe('relative/path');
  });

  it('marks an explicit override and restores inheritance explicitly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileAlias: 'Default Profile',
      profileWorkingDirPath: '/profiles/default',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    expect(
      container.querySelector(
        '[aria-label="Node working directory: /node/work"]',
      ),
    ).not.toBeNull();
    await openPopover();
    const restore = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore Profile inheritance',
    );
    assert(restore);
    await act(async () => restore.click());
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
