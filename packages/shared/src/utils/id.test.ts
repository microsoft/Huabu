// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createId, createUuid } from './id.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID when available', () => {
    expect(createUuid()).toMatch(UUID_V4);
    expect(createId('node')).toMatch(/^node-/);
  });

  it('builds a v4 UUID from getRandomValues without randomUUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });
    expect(createUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('throws instead of falling back to Math.random', () => {
    vi.stubGlobal('crypto', undefined);
    const random = vi.spyOn(Math, 'random');
    expect(() => createUuid()).toThrow(/Web Crypto/);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
