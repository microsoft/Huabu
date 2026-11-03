// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it } from 'vitest';

import {
  installDesktopInputGuard,
  setDesktopInputFrozen,
} from './desktopInput';

afterEach(() => {
  setDesktopInputFrozen(false);
  document.body.replaceChildren();
});

it('keeps only the deletion overlay accessible and freezes new background portals', async () => {
  const page = document.createElement('main');
  const overlay = document.createElement('div');
  overlay.dataset.desktopDeletionDialog = 'true';
  document.body.append(page, overlay);
  const cleanup = installDesktopInputGuard();
  try {
    setDesktopInputFrozen(true, 'space-deletion');
    expect(document.body.inert).toBe(false);
    expect(page.inert).toBe(true);
    expect(overlay.inert).not.toBe(true);
    const key = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    overlay.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    const edit = new Event('beforeinput', { bubbles: true, cancelable: true });
    page.dispatchEvent(edit);
    expect(edit.defaultPrevented).toBe(true);
    const portal = document.createElement('div');
    document.body.append(portal);
    const controls = document.createElement('dialog');
    controls.dataset.desktopCloseControls = 'true';
    controls.open = true;
    document.body.append(controls);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(portal.inert).toBe(true);
    expect(controls.inert).not.toBe(true);
    const cancel = new MouseEvent('click', { bubbles: true, cancelable: true });
    controls.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(false);
    setDesktopInputFrozen(false);
    expect(page.inert).not.toBe(true);
    expect(portal.inert).not.toBe(true);
  } finally {
    cleanup();
  }
});

it('retains body-wide freezing for ordinary close and restores existing inert state', () => {
  const page = document.createElement('main');
  page.inert = true;
  document.body.append(page);
  setDesktopInputFrozen(true, 'space-deletion');
  setDesktopInputFrozen(true);
  expect(document.body.inert).toBe(true);
  setDesktopInputFrozen(false);
  expect(document.body.inert).toBe(false);
  expect(page.inert).toBe(true);
});
