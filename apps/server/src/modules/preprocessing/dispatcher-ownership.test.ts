// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

vi.mock('../agent/functional-text.js', () => ({ runFunctionalText: vi.fn() }));

import { PreprocessDispatcher } from './dispatcher.js';
import { runFunctionalText } from '../agent/functional-text.js';
import {
  openPersonalSettings,
  personalSettingsOwner,
  useCaller,
} from '../identity/personal-settings.js';
import { mountTestWorkspace } from '../storage/testing.js';

it('coalesces repeated preprocessing of a shared Space across its users', async () => {
  const opened = await mountTestWorkspace({
    structured: { kind: 'disk' },
    blobs: { kind: 'disk' },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: (string | null)[] = [];
  vi.mocked(runFunctionalText).mockImplementation(async () => {
    const owner = personalSettingsOwner();
    seen.push(owner);
    await gate;
    return `${owner} title`;
  });
  const dispatcher = new PreprocessDispatcher();
  const preprocess = (principalId: string) =>
    openPersonalSettings(() => {
      useCaller({
        principal: { principalId, kind: 'user' },
        member: true,
        owner: true,
        access: {
          can: async () => true,
          claim: async () => {},
          workspaces: async () => 'all',
        },
      });
      return dispatcher.preprocess({
        canvasId: 'shared',
        nodeId: 'node-frame',
        nodeType: 'frame',
        trigger: 'node_inserted',
        snapshot: { childLabels: ['One', 'Two'] },
        options: { allowPersistence: false },
      });
    });
  const runs = [preprocess('alice'), preprocess('alice'), preprocess('bob')];
  try {
    // Every viewer's tab asks after the same broadcast edit; one run serves
    // them all, rather than one per person racing to patch the same node.
    await vi.waitFor(() => expect(seen).toEqual(['alice']));
    release();
    const results = await Promise.all(runs);
    expect(seen).toEqual(['alice']);
    expect(results.map((result) => result.patch.label)).toEqual([
      'alice title',
      'alice title',
      'alice title',
    ]);
    expect(results.every((result) => result.success)).toBe(true);
  } finally {
    release();
    await Promise.allSettled(runs);
    await opened.close();
  }
});
