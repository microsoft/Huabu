// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyRow } from './ApiKeyRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderRow(
  onSave = vi.fn(),
  onRemove: (() => void) | null = vi.fn(),
  disabled = false,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ApiKeyRow
        title="API Key"
        saved
        placeholder="secret"
        disabled={disabled}
        onSave={onSave}
        onRemove={onRemove ?? undefined}
      />,
    );
  });
  return { onSave, onRemove };
}

describe('ApiKeyRow', () => {
  it('keeps removal out of the default state', () => {
    renderRow();

    expect(
      container?.querySelector('[aria-label="settings.keyConfigured"]'),
    ).not.toBeNull();
    expect(container?.textContent).toContain('settings.updateKey');
    expect(container?.querySelectorAll('button')).toHaveLength(1);
  });

  it('saves explicitly from the editing state', () => {
    const { onSave } = renderRow();
    const updateButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.updateKey',
    )!;

    act(() => updateButton.click());
    const input = container!.querySelector('input')!;
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, 'new-secret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onSave).not.toHaveBeenCalled();
    const saveButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.save',
    )!;
    act(() => saveButton.click());
    expect(onSave).toHaveBeenCalledWith('new-secret');
  });

  it('removes a saved key when an empty value is saved', () => {
    const { onRemove } = renderRow();
    const updateButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.updateKey',
    )!;

    act(() => updateButton.click());
    const saveButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.save',
    )!;
    expect(saveButton.disabled).toBe(false);
    act(() => saveButton.click());
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('disables empty saves when removal is not supported', () => {
    renderRow(vi.fn(), null);
    const updateButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.updateKey',
    )!;

    act(() => updateButton.click());
    const saveButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.save',
    )!;
    expect(saveButton.disabled).toBe(true);
  });

  it('prevents editing when credential storage is read-only', () => {
    renderRow(vi.fn(), vi.fn(), true);
    const updateButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.updateKey',
    )!;

    expect(updateButton.disabled).toBe(true);
    act(() => updateButton.click());
    expect(container?.querySelector('input')).toBeNull();
  });
});
