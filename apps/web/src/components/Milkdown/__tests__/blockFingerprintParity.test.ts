// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Cross-host block-key parity gate.
 *
 * Provenance is computed on the SERVER from the raw markdown the LLM /
 * user produced, but rendered on the CLIENT against markdown that has
 * passed through Milkdown's parse → serialize round-trip (which
 * renormalizes cosmetic syntax). For server-authored provenance keys to
 * line up with the client's live blocks, the shared
 * `fingerprintMarkdownKeys` MUST return identical keys for both shapes.
 *
 * This test mounts a real Crepe editor (same config as production
 * `createMilkdown`), round-trips each fixture, and asserts:
 *   1. key parity: keys(raw) === keys(milkdownSerialize(parse(raw)))
 *   2. segmentation parity: block count === PM top-level child count
 *      (so the client can map key[i] → PM child[i] by index).
 */

// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parserCtx, serializerCtx } from '@milkdown/core';
import { Crepe } from '@milkdown/crepe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fingerprintMarkdownKeys } from '@huabu/shared/canvas-engine';

import type { Node as PMNode } from '@milkdown/prose/model';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): string =>
  readFileSync(resolve(here, 'fixtures', name), 'utf-8');

interface Harness {
  /** Round-trip markdown through Milkdown; also report PM block count. */
  roundTrip(markdown: string): { serialized: string; pmBlockCount: number };
  destroy(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: '',
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
  });
  await crepe.create();
  return {
    roundTrip(markdown: string) {
      return crepe.editor.action((ctx) => {
        const parser = ctx.get(parserCtx);
        const serializer = ctx.get(serializerCtx);
        const doc = parser(markdown) as PMNode | null;
        if (!doc) return { serialized: '', pmBlockCount: 0 };
        return { serialized: serializer(doc), pmBlockCount: doc.childCount };
      });
    },
    async destroy() {
      await crepe.destroy();
      root.remove();
    },
  };
}

const FIXTURES = ['simple.md', 'math.md', 'complex.md', 'ai-half-baked.md'];

describe('block-key parity: server(raw md) ↔ client(Milkdown round-trip)', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness?.destroy();
  });

  for (const fixture of FIXTURES) {
    it(`${fixture}: raw and round-tripped markdown fingerprint identically`, () => {
      const raw = loadFixture(fixture);
      const { serialized, pmBlockCount } = harness.roundTrip(raw);

      const rawKeys = fingerprintMarkdownKeys(raw);
      const rtKeys = fingerprintMarkdownKeys(serialized);

      // 1. Key parity across the two markdown shapes.
      expect(rtKeys).toEqual(rawKeys);
      // 2. Segmentation parity — index mapping key[i] ↔ PM child[i].
      expect(rawKeys.length).toBe(pmBlockCount);
    });
  }
});
