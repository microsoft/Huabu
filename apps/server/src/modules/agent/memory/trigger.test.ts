// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory-worker bookkeeping over the storage extension substrate.
 *
 * This is the first owner to build a store on a substrate, so it doubles as
 * evidence that the substrate is usable without the port growing a data API:
 * everything here is this module's own format, in a place storage handed it
 * and never reads (proposal §6.4.4).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bumpOpCounter,
  markAnalyzed,
  OP_THRESHOLD,
  readMemoryState,
} from './trigger.js';
import { createSpace, deleteSpace, space } from '../../storage/index.js';
import { setWorkspacePath } from '../../workspace.js';

const CANVAS = 'canvas-memory-trigger';
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'huabu-memory-trigger-'));
  setWorkspacePath(tmp);
  const created = await createSpace(CANVAS, 'Trigger');
  if (!created.ok) throw new Error('Expected to create the Space');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('memory trigger state', () => {
  it('starts from zero and persists what it counts', async () => {
    await expect(readMemoryState(CANVAS)).resolves.toEqual({
      counter: 0,
      lastAnalyzedAt: null,
      lastSeenThreadCursor: null,
    });

    await expect(bumpOpCounter(CANVAS, 3)).resolves.toBe(false);
    await expect(bumpOpCounter(CANVAS, 4)).resolves.toBe(false);

    await expect(readMemoryState(CANVAS)).resolves.toMatchObject({
      counter: 7,
    });
  });

  it('signals once at the threshold and resets in the same write', async () => {
    await expect(bumpOpCounter(CANVAS, OP_THRESHOLD)).resolves.toBe(true);

    // Reset in the same write, so the very next op batch cannot double-fire.
    await expect(readMemoryState(CANVAS)).resolves.toMatchObject({
      counter: 0,
    });
    await expect(bumpOpCounter(CANVAS, 1)).resolves.toBe(false);
  });

  it('keeps concurrent bumps from losing increments', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => bumpOpCounter(CANVAS, 1)),
    );

    await expect(readMemoryState(CANVAS)).resolves.toMatchObject({
      counter: 10,
    });
  });

  it('records an analysis pass without touching the counter', async () => {
    await bumpOpCounter(CANVAS, 5);
    await markAnalyzed(CANVAS, { lastSeenThreadCursor: 42 });

    const state = await readMemoryState(CANVAS);
    expect(state.counter).toBe(5);
    expect(state.lastSeenThreadCursor).toBe(42);
    expect(state.lastAnalyzedAt).toEqual(expect.any(Number));
  });

  it('keeps each Space to its own bookkeeping', async () => {
    const other = 'canvas-memory-trigger-other';
    const created = await createSpace(other, 'Other');
    if (!created.ok) throw new Error('Expected to create the second Space');

    await bumpOpCounter(CANVAS, 4);
    await bumpOpCounter(other, 9);

    await expect(readMemoryState(CANVAS)).resolves.toMatchObject({
      counter: 4,
    });
    await expect(readMemoryState(other)).resolves.toMatchObject({ counter: 9 });
  });

  it('drops a write for a Space that was deleted mid-flight', async () => {
    await bumpOpCounter(CANVAS, 1);
    const spaceDir = space(CANVAS).diskTree?.directory();
    if (!spaceDir) throw new Error('Expected the Disk backend in this test');

    await deleteSpace(CANVAS);

    // The op-counter hook fires after the delete has already removed the
    // Space. This used to need a guard here — a bare write would recreate the
    // directory as a stub holding nothing but bookkeeping. The port refuses a
    // substrate for a Space that is gone, so the write is a silent no-op and
    // nothing is resurrected.
    await expect(bumpOpCounter(CANVAS, 1)).resolves.toBe(false);
    expect(existsSync(spaceDir)).toBe(false);
  });
});
