// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Regression guard for the server's default bind interface.
 *
 * Huabu ships as a desktop app over loopback by default; the
 * Electron main process explicitly sets `HUABU_BIND_HOST=127.0.0.1`
 * but if anyone ever lifts that env injection (or a future contributor
 * "helpfully" flips the default to `0.0.0.0` to make standalone server
 * deployments easier), the desktop app would silently expose itself
 * to the local network. This test pins the safe default so that
 * change has to be deliberate.
 */

import { describe, expect, it } from 'vitest';

import { resolveBindHost } from './bind-host.js';

describe('resolveBindHost', () => {
  it('defaults to loopback when HUABU_BIND_HOST is unset', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('returns the env value verbatim when HUABU_BIND_HOST is set', () => {
    expect(resolveBindHost({ HUABU_BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ HUABU_BIND_HOST: '10.0.0.5' })).toBe('10.0.0.5');
    expect(resolveBindHost({ HUABU_BIND_HOST: '::1' })).toBe('::1');
  });

  it('treats empty string as a deliberate (if useless) override', () => {
    // Documenting current behaviour: `env.HUABU_BIND_HOST ?? '127.0.0.1'`
    // only falls back on null/undefined, NOT on empty string. If we
    // ever change that, update the test.
    expect(resolveBindHost({ HUABU_BIND_HOST: '' })).toBe('');
  });
});
