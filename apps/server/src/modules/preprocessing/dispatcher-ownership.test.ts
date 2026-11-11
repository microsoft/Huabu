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

it.each([false, true])(
  'coalesces shared-Space preprocessing only for the same settings owner (first owner fails: %s)',
  async (firstOwnerFails) => {
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
      if (firstOwnerFails && owner === 'alice') {
        throw new Error('Alice has no configured Utility Agent');
      }
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
      // A member's tabs share one run, but another member must use their own
      // model settings and receive their own result or configuration failure.
      await vi.waitFor(() => expect(seen).toEqual(['alice', 'bob']));
      release();
      const results = await Promise.all(runs);
      expect(seen).toEqual(['alice', 'bob']);
      expect(results.map((result) => result.patch.label)).toEqual([
        firstOwnerFails ? undefined : 'alice title',
        firstOwnerFails ? undefined : 'alice title',
        'bob title',
      ]);
      expect(results.every((result) => result.success)).toBe(true);
      for (const result of results.slice(0, 2)) {
        expect(
          result.diagnostics.some((diagnostic) =>
            diagnostic.message.includes(
              'Alice has no configured Utility Agent',
            ),
          ),
        ).toBe(firstOwnerFails);
      }
      expect(results[2]?.diagnostics).toEqual([]);
    } finally {
      release();
      await Promise.allSettled(runs);
      await opened.close();
    }
  },
);
