// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import {
  openExternalNoteSession,
  resetExternalNoteSessions,
} from './external-watcher.js';
import { space } from '../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';

import type * as Fs from 'node:fs';

const watch = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  watch.mockImplementation(fs.watch);
  return { ...fs, watch };
});

let mounted: MountedTestStorage | undefined;
const originalPlatform = process.platform;

afterEach(async () => {
  resetExternalNoteSessions();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.useRealTimers();
  watch.mockClear();
  await mounted?.close();
  mounted = undefined;
});

it.each(['linux', 'win32'])(
  'leaves an unknown Disk Space inert on %s',
  async (platform) => {
    mounted = await mountTestWorkspace({
      structured: { kind: 'disk' },
      blobs: { kind: 'disk' },
    });
    // The real facade supplies a Disk tree even for an absent Space.
    expect(space('unknown-space').diskTree).not.toBeNull();
    expect(await space('unknown-space').read()).toBeNull();
    Object.defineProperty(process, 'platform', { value: platform });
    vi.useFakeTimers();
    const session = await openExternalNoteSession('unknown-space', vi.fn());
    try {
      expect(session.snapshot).toEqual([]);
      expect(watch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      session.close();
    }
  },
);

it('still watches a known Disk Space through its real directory', async () => {
  mounted = await mountTestWorkspace({
    structured: { kind: 'disk' },
    blobs: { kind: 'disk' },
  });
  expect(
    (
      await mounted.storage.structured
        .spaces()
        .create({ canvasId: 'known-space', title: 'Known Space' })
    ).ok,
  ).toBe(true);
  const tree = space('known-space').diskTree;
  expect(tree?.existingDirectory()).toBe(tree?.directory());
  const session = await openExternalNoteSession('known-space', vi.fn());
  try {
    expect(watch).toHaveBeenCalled();
    expect(
      watch.mock.calls.every(
        ([directory]) =>
          directory === tree?.directory() ||
          directory === tree?.nodesDirectory(),
      ),
    ).toBe(true);
  } finally {
    session.close();
  }
});
