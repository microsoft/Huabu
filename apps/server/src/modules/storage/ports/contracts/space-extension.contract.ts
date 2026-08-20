// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable contract for the extension substrate.
 *
 * Isolation and lifecycle, and nothing else — there is no data behaviour to
 * assert, because the port never sees what an owner puts in a namespace. That
 * is also why the harness supplies the read and write: the suite states what
 * must be true of *whatever* an owner stored, and each backend says how one
 * stores it.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type {
  SpaceHandle,
  SpaceRepository,
  SpaceSubstrate,
} from '../structured.js';

export interface SpaceExtensionContractHarness {
  /** Collection, so a case can create and destroy the Space it works on. */
  readonly repository: SpaceRepository;
  readonly space: (canvasId: string) => SpaceHandle;
  /** Store `value` in a substrate the way an owner of it would. */
  readonly write: (
    substrate: SpaceSubstrate,
    value: string,
  ) => Promise<void> | void;
  /** Read back what {@link write} stored, or null when nothing is there. */
  readonly read: (
    substrate: SpaceSubstrate,
  ) => Promise<string | null> | string | null;
  readonly cleanup?: () => Promise<void> | void;
}

const OWNED = 'contract.owner';
const OTHER = 'contract.other';

export function describeSpaceExtensionContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceExtensionContractHarness>
    | SpaceExtensionContractHarness,
): void {
  describe(`Space extension contract: ${name}`, () => {
    let harness: SpaceExtensionContractHarness | null = null;

    async function open(): Promise<SpaceExtensionContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    /** Create a Space and return a substrate for it. */
    async function substrateFor(
      h: SpaceExtensionContractHarness,
      canvasId: string,
      namespace = OWNED,
    ): Promise<SpaceSubstrate> {
      const created = await h.repository.create({ canvasId, title: canvasId });
      if (!created.ok && created.reason !== 'already-exists') {
        throw new Error(`Expected to create ${canvasId}`);
      }
      const substrate = await h.space(canvasId).extension(namespace);
      if (!substrate) {
        throw new Error(`Expected a substrate for ${canvasId}/${namespace}`);
      }
      return substrate;
    }

    it('refuses a namespace without an owner prefix', async () => {
      const { repository, space } = await open();
      await repository.create({
        canvasId: 'contract-ext-grammar',
        title: 'Grammar',
      });

      // The owner prefix is what makes a collision the owner's problem rather
      // than storage's, so a bare name is refused rather than accommodated.
      await expect(
        space('contract-ext-grammar').extension('memory'),
      ).rejects.toThrow();
      await expect(
        space('contract-ext-grammar').extension('Huabu.Memory'),
      ).rejects.toThrow();
      await expect(
        space('contract-ext-grammar').extension('huabu.mem_ory'),
      ).rejects.toThrow();
    });

    it('has no substrate for a Space that does not exist', async () => {
      const { space } = await open();

      // Load-bearing: an owner writing through a substrate it was handed for a
      // deleted Space could recreate that Space as a stub.
      await expect(
        space('contract-ext-absent').extension(OWNED),
      ).resolves.toBeNull();
    });

    it('keeps two namespaces on one Space apart', async () => {
      const h = await open();
      const owned = await substrateFor(h, 'contract-ext-two-ns', OWNED);
      const other = await substrateFor(h, 'contract-ext-two-ns', OTHER);

      await h.write(owned, 'owned value');
      await h.write(other, 'other value');

      await expect(await h.read(owned)).toBe('owned value');
      await expect(await h.read(other)).toBe('other value');
    });

    it('keeps one namespace on two Spaces apart', async () => {
      const h = await open();
      const first = await substrateFor(h, 'contract-ext-space-a');
      const second = await substrateFor(h, 'contract-ext-space-b');

      await h.write(first, 'first value');
      await h.write(second, 'second value');

      await expect(await h.read(first)).toBe('first value');
      await expect(await h.read(second)).toBe('second value');
    });

    it('resolves the same namespace to the same place every time', async () => {
      const h = await open();
      const first = await substrateFor(h, 'contract-ext-stable');
      await h.write(first, 'written once');

      const again = await h.space('contract-ext-stable').extension(OWNED);
      if (!again) throw new Error('Expected a substrate');

      await expect(await h.read(again)).toBe('written once');
    });

    it('destroys a namespace with the Space', async () => {
      const h = await open();
      const canvasId = 'contract-ext-lifecycle';
      const substrate = await substrateFor(h, canvasId);
      await h.write(substrate, 'should not survive');
      await expect(await h.read(substrate)).toBe('should not survive');

      const started = await h.repository.beginDelete({ canvasId });
      if (!started.ok) throw new Error('Ordinary Space must be deletable');
      await expect(started.session.finish()).resolves.toEqual({
        ok: true,
        reason: 'deleted',
      });

      // Recreated under the same id, so this asserts the namespace was
      // destroyed rather than merely unreachable. Storage owns this because
      // only it can: no owner can clean up a layout that is not its own, and
      // requiring one to register a hook would make deletion depend on every
      // extension being loaded.
      const recreated = await substrateFor(h, canvasId);
      await expect(await h.read(recreated)).toBeNull();
    });
  });
}
