// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable contract every server-record adapter must satisfy. */

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerRecordStore } from '../server-records.js';

export interface ServerRecordStoreContractHarness {
  /** An initialized adapter over empty storage. */
  readonly store: ServerRecordStore;
  /** A second initialized adapter over the same storage, as after a restart. */
  readonly reopen: () => Promise<ServerRecordStore>;
  readonly cleanup?: () => Promise<void> | void;
}

const ALICE = 'a'.repeat(32);
const BOB = 'b'.repeat(32);

export function describeServerRecordStoreContract(
  name: string,
  createHarness: () =>
    | Promise<ServerRecordStoreContractHarness>
    | ServerRecordStoreContractHarness,
): void {
  describe(`ServerRecordStore contract: ${name}`, () => {
    let harness: ServerRecordStoreContractHarness | null = null;

    async function open(): Promise<ServerRecordStoreContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reports a record that was never written as null', async () => {
      const { store } = await open();

      expect(store.get({ owner: null, name: 'model-settings' })).toBeNull();
      expect(store.get({ owner: ALICE, name: 'model-settings' })).toBeNull();
      await expect(store.keys()).resolves.toEqual([]);
    });

    it('keeps the deployment record apart from every person’s copy', async () => {
      const { store } = await open();
      await store.put({ owner: null, name: 'model-settings' }, { who: 'ops' });
      await store.put({ owner: ALICE, name: 'model-settings' }, { who: 'a' });
      await store.put({ owner: BOB, name: 'model-settings' }, { who: 'b' });

      expect(store.get({ owner: null, name: 'model-settings' })).toEqual({
        who: 'ops',
      });
      expect(store.get({ owner: ALICE, name: 'model-settings' })).toEqual({
        who: 'a',
      });
      expect(store.get({ owner: BOB, name: 'model-settings' })).toEqual({
        who: 'b',
      });
      expect(store.get({ owner: ALICE, name: 'agent-defaults' })).toBeNull();
    });

    it('replaces a record whole and returns a copy the caller may mutate', async () => {
      const { store } = await open();
      const key = { owner: null, name: 'device-owners' } as const;
      await store.put(key, { first: 'alice', second: 'bob' });
      await store.put(key, { third: 'carol' });

      const read = store.get(key) as Record<string, string>;
      expect(read).toEqual({ third: 'carol' });
      read['fourth'] = 'dave';
      expect(store.get(key)).toEqual({ third: 'carol' });
    });

    it('round-trips every JSON shape except null', async () => {
      const { store } = await open();
      const values = [
        { nested: [1, 'two', true, null, { deep: 'value' }] },
        ['list'],
        'text',
        0,
        false,
      ];
      for (const [index, value] of values.entries()) {
        const key = {
          owner: index === 0 ? null : ALICE,
          name: (
            [
              'credentials',
              'model-settings',
              'agent-defaults',
              'change-review',
              'device-names',
            ] as const
          )[index],
        };
        await store.put(key, value);
        expect(store.get(key)).toEqual(value);
      }
      await expect(
        store.put({ owner: null, name: 'agent-defaults' }, null),
      ).rejects.toThrow('other than null');
      await expect(
        store.put({ owner: null, name: 'agent-defaults' }, undefined),
      ).rejects.toThrow('other than null');
      expect(store.get({ owner: null, name: 'agent-defaults' })).toBeNull();
    });

    it('serves acknowledged records to a reopened adapter', async () => {
      const { store, reopen } = await open();
      await store.put(
        { owner: null, name: 'agent-credential-versions' },
        {
          alice: 3,
        },
      );
      await store.put({ owner: BOB, name: 'device-names' }, { d: 'Desk' });

      const restarted = await reopen();
      expect(
        restarted.get({ owner: null, name: 'agent-credential-versions' }),
      ).toEqual({ alice: 3 });
      expect(restarted.get({ owner: BOB, name: 'device-names' })).toEqual({
        d: 'Desk',
      });
    });

    it('lists exactly the stored keys', async () => {
      const { store } = await open();
      await store.put({ owner: null, name: 'credentials' }, { v: 1 });
      await store.put({ owner: null, name: 'user-agent-profiles' }, { v: 1 });
      await store.put({ owner: ALICE, name: 'change-review' }, { v: 1 });
      await store.put({ owner: ALICE, name: 'change-review' }, { v: 2 });

      const keys = await store.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toEqual(
        expect.arrayContaining([
          { owner: null, name: 'credentials' },
          { owner: null, name: 'user-agent-profiles' },
          { owner: ALICE, name: 'change-review' },
        ]),
      );
    });

    it('refuses keys no adapter may store', async () => {
      const { store } = await open();
      const invalid = [
        { owner: null, name: 'unknown' },
        { owner: '../escape', name: 'model-settings' },
        { owner: 'A'.repeat(32), name: 'model-settings' },
        // Only the deployment holds credentials, Profiles, and ownership.
        { owner: ALICE, name: 'credentials' },
        { owner: ALICE, name: 'device-owners' },
      ] as const;
      for (const key of invalid) {
        // @ts-expect-error -- deliberately invalid keys
        expect(() => store.get(key)).toThrow();
        // @ts-expect-error -- deliberately invalid keys
        await expect(store.put(key, { v: 1 })).rejects.toThrow();
      }
      await expect(store.keys()).resolves.toEqual([]);
    });
  });
}
