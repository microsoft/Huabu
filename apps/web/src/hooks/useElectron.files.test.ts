// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { openInNewWindow, openServerFileInDesktop } from './useElectron';

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
  expect(open).toHaveBeenCalledWith(
    `${window.location.origin}/api/canvas/a/artifact/shot.png`,
  );

  // A refusal is logged, never thrown into the click handler.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  open.mockRejectedValueOnce(new Error('refused'));
  expect(openServerFileInDesktop('/api/x')).toBe(true);
  await vi.waitFor(() => expect(logged).toHaveBeenCalled());
});

it('takes only what this Server serves, leaving every other link alone', () => {
  const open = vi.fn().mockResolvedValue(undefined);
  window.electronBridge = { files: { open } } as never;
  for (const url of [
    // An image an Agent left at its remote address.
    'https://example.com/shot.png',
    'http://127.0.0.1:9999/api/canvas/a/artifact/shot.png',
    // A route of the application itself opens as a Tab.
    '/canvas/a',
    `${window.location.origin}/spaces`,
    'mailto:someone@example.com',
    'not a url at all://',
  ])
    expect(openServerFileInDesktop(url)).toBe(false);
  expect(open).not.toHaveBeenCalled();

  expect(
    openServerFileInDesktop(
      `${window.location.origin}/api/canvas/a/artifact/x`,
    ),
  ).toBe(true);
  expect(open).toHaveBeenCalledWith(
    `${window.location.origin}/api/canvas/a/artifact/x`,
  );
});

it('opens a new window for anything the desktop app does not take', () => {
  const opened = vi.spyOn(window, 'open').mockReturnValue(null);
  const open = vi.fn().mockResolvedValue(undefined);
  window.electronBridge = { files: { open } } as never;

  openInNewWindow('https://example.com/page');
  expect(opened).toHaveBeenCalledWith(
    'https://example.com/page',
    '_blank',
    'noopener,noreferrer',
  );
  openInNewWindow('/api/canvas/a/artifact/page.html', 'noopener');
  expect(opened).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);

  // In a plain browser everything opens the usual way.
  delete window.electronBridge;
  openInNewWindow('/api/canvas/a/artifact/page.html', 'noopener');
  expect(opened).toHaveBeenLastCalledWith(
    '/api/canvas/a/artifact/page.html',
    '_blank',
    'noopener',
  );
});
