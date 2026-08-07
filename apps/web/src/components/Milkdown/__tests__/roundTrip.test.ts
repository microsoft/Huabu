// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Permanent Phase 1b round-trip harness.
 *
 * Validates that the Crepe parser + serializer pair (the only place
 * where markdown can lose information when it flows through Milkdown)
 * converges after the first normalization pass for the four fixture
 * families that motivated the migration:
 *
 *   - `simple.md`         — basic CommonMark surface.
 *   - `math.md`           — KaTeX inline / block / matrix.
 *   - `complex.md`        — GFM tables, nested lists, task lists,
 *                            fenced code, hard breaks.
 *   - `ai-half-baked.md`  — bad-but-realistic AI output (unclosed
 *                            fences, mixed list markers, CJK + ASCII).
 *
 * "First pass may renormalize (table column widths, list markers,
 * etc.); from the second pass onward output MUST be byte-stable."
 *
 * The harness works directly against `parserCtx` / `serializerCtx`
 * inside a Crepe-configured Editor — it bypasses the ProseMirror
 * EditorView transaction layer so the test does not depend on the
 * subset of `EditorView` behaviour that happy-dom emulates. The
 * editor still mounts (Crepe currently has no path that builds a
 * schema without a view) but its view is never exercised.
 */

// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parserCtx, serializerCtx } from '@milkdown/core';
import { Crepe } from '@milkdown/crepe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): string =>
  readFileSync(resolve(here, 'fixtures', name), 'utf-8');

interface RoundTripHarness {
  /** Run a single markdown → PM doc → markdown round trip. */
  roundTrip(markdown: string): string;
  destroy(): Promise<void>;
}

/**
 * Build a Crepe editor in a configuration that mirrors production
 * `createMilkdown.ts` (same disabled features), and expose only the
 * parser + serializer. We deliberately do NOT call any editor view
 * transactions in the test — those are the parts of ProseMirror that
 * happy-dom emulates incompletely.
 */
async function createHarness(): Promise<RoundTripHarness> {
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
    roundTrip(markdown: string): string {
      return crepe.editor.action((ctx) => {
        const parser = ctx.get(parserCtx);
        const serializer = ctx.get(serializerCtx);
        const doc = parser(markdown);
        if (!doc) return '';
        return serializer(doc);
      });
    },
    async destroy() {
      await crepe.destroy();
      root.remove();
    },
  };
}

/** Strip CRLF + trailing whitespace; mirrors `normalizeMarkdown` rules
 *  that the wrapper applies on every emit so the round-trip comparison
 *  matches what production actually sees. */
function normalize(md: string): string {
  return md.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

interface RoundTripHistory {
  /** Iteration 0 = normalized input, iteration N = output after N passes. */
  history: string[];
}

async function runRoundTrip(
  harness: RoundTripHarness,
  source: string,
  iterations = 3,
): Promise<RoundTripHistory> {
  const history: string[] = [normalize(source)];
  for (let i = 0; i < iterations; i++) {
    const next = normalize(harness.roundTrip(history[history.length - 1]));
    history.push(next);
  }
  return { history };
}

describe('Milkdown round-trip (Gate G1, parser ↔ serializer)', () => {
  let harness: RoundTripHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.destroy();
  });

  for (const fixture of [
    'simple.md',
    'math.md',
    'complex.md',
    'ai-half-baked.md',
  ]) {
    it(`${fixture}: stabilizes after the first normalization pass`, async () => {
      const { history } = await runRoundTrip(harness, loadFixture(fixture));
      // Pass 1 is allowed to renormalize (e.g. table column widths,
      // list markers, unclosed fences); passes 2+ must be byte-stable.
      expect(history[2]).toBe(history[1]);
      expect(history[3]).toBe(history[2]);
    });
  }
});
