// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { openServerFileInDesktop } from './useElectron';

afterEach(() => {
  delete window.electronBridge;
  vi.restoreAllMocks();
});

it('leaves the link to the browser when there is no desktop bridge for files', () => {
  expect(openServerFileInDesktop('/api/canvas/a/artifact/shot.png')).toBe(
    false,
  );
  // A desktop app connected to a remote Server: the browser can open it.
  window.electronBridge = { isElectron: true } as never;
  expect(openServerFileInDesktop('/api/canvas/a/artifact/shot.png')).toBe(
    false,
  );
});

it('hands the file to the desktop app and reports that it took the link', async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  window.electronBridge = { files: { open } } as never;
  expect(openServerFileInDesktop('/api/canvas/a/artifact/shot.png')).toBe(true);
  expect(open).toHaveBeenCalledWith('/api/canvas/a/artifact/shot.png');

  // A refusal is logged, never thrown into the click handler.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  open.mockRejectedValueOnce(new Error('refused'));
  expect(openServerFileInDesktop('/x')).toBe(true);
  await vi.waitFor(() => expect(logged).toHaveBeenCalled());
});
