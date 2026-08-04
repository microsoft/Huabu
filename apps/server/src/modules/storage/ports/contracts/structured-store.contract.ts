/**
 * Contract for the lifecycle and Space-handle boundary currently exposed by
 * {@link StructuredStore}.
 *
 * This deliberately does not describe record repositories or asynchronous
 * query semantics: {@link SpaceHandle} is still the disk-oriented
 * `CanvasStore`. Future structured adapters must first narrow that handle;
 * until then, this suite checks only behavior the port genuinely promises.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { StructuredStore } from '../structured.js';

export interface StructuredContractHarness {
  store: StructuredStore;
  cleanup?: () => Promise<void> | void;
}

export function describeStructuredStoreContract(
  name: string,
  createHarness: () =>
    | Promise<StructuredContractHarness>
    | StructuredContractHarness,
): void {
  describe(`StructuredStore contract: ${name}`, () => {
    let harness: StructuredContractHarness | null = null;

    async function open(): Promise<StructuredStore> {
      harness = await createHarness();
      await harness.store.init();
      return harness.store;
    }

    afterEach(async () => {
      await harness?.store.close();
      await harness?.cleanup?.();
      harness = null;
    });

    it('initializes, reports healthy backend identity, and closes', async () => {
      const store = await open();
      const health = await store.health();

      expect(health).toMatchObject({ ok: true, kind: store.kind });
      await expect(store.close()).resolves.toBeUndefined();
    });

    it('returns an equivalent handle for the same valid Space id', async () => {
      const store = await open();
      const first = store.space('canvas-a');
      const second = store.space('canvas-a');

      // Object identity is a caching detail of one adapter, not a port
      // promise: the Disk cache is bounded, so a process working with more
      // Spaces than it holds can be handed a fresh instance for an id it
      // served before. What the port guarantees is that both handles denote
      // the same Space. The Disk adapter's own test covers its caching.
      expect(second.canvasId).toBe(first.canvasId);
      expect(first.canvasId).toBe('canvas-a');
    });

    it('scopes handles by Space id', async () => {
      const store = await open();
      const first = store.space('canvas-a');
      const second = store.space('canvas-b');

      expect(second.canvasId).not.toBe(first.canvasId);
      expect(first.canvasId).toBe('canvas-a');
      expect(second.canvasId).toBe('canvas-b');
    });

    it.each(['', '../escape', 'nested/canvas', 'canvas with spaces'])(
      'rejects invalid Space id %j',
      async (canvasId) => {
        const store = await open();
        expect(() => store.space(canvasId)).toThrow(/Invalid canvasId/);
      },
    );
  });
}
