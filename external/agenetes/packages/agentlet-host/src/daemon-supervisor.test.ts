import { describe, expect, it } from 'vitest';

import { filterHostNamespacedEnv } from './daemon-supervisor.js';

describe('filterHostNamespacedEnv', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    HUABU_SECRET_KEY: 'super-secret',
    HUABU_DATA_DIR: '/data',
    HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/c1',
  } satisfies NodeJS.ProcessEnv;

  it('drops every host-namespaced var when the allowlist is empty', () => {
    const out = filterHostNamespacedEnv(base, 'HUABU_', []);
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/agent' });
  });

  it('keeps only allow-listed host-namespaced vars', () => {
    const out = filterHostNamespacedEnv(base, 'HUABU_', ['HUABU_RFS_URL']);
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      HUABU_RFS_URL: 'http://127.0.0.1:3001/api/rfs/c1',
    });
  });

  it('is a no-op passthrough when no prefix is given', () => {
    const out = filterHostNamespacedEnv(base, undefined, undefined);
    expect(out).toEqual(base);
  });

  it('preserves non-namespaced OS/toolchain vars verbatim', () => {
    const out = filterHostNamespacedEnv(
      { PATH: '/usr/bin', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', HUABU_X: 'y' },
      'HUABU_',
      [],
    );
    expect(out).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
    });
  });

  it('skips undefined values without emitting the key', () => {
    const out = filterHostNamespacedEnv(
      { PATH: '/usr/bin', MAYBE: undefined },
      'HUABU_',
      [],
    );
    expect(out).toEqual({ PATH: '/usr/bin' });
    expect('MAYBE' in out).toBe(false);
  });

  it('does not mutate the input environment', () => {
    const input = { HUABU_SECRET_KEY: 's', PATH: '/usr/bin' };
    filterHostNamespacedEnv(input, 'HUABU_', []);
    expect(input).toEqual({ HUABU_SECRET_KEY: 's', PATH: '/usr/bin' });
  });
});
