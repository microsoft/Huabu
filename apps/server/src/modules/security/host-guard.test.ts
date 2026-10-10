// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveAllowedHostnames } from './host-guard.js';

describe('resolveAllowedHostnames', () => {
  it('includes the canonical public hostname without duplicate configuration', () => {
    expect(
      resolveAllowedHostnames({
        HUABU_PUBLIC_ORIGIN: 'https://huabu.example.com:8443',
      }),
    ).toEqual(
      new Set(['localhost', '127.0.0.1', '[::1]', 'huabu.example.com']),
    );
  });

  it('keeps HUABU_ALLOWED_HOSTS as optional extra aliases', () => {
    expect(
      resolveAllowedHostnames({
        HUABU_PUBLIC_ORIGIN: 'https://huabu.example.com',
        HUABU_ALLOWED_HOSTS: '192.168.1.50, admin.example.com',
      }),
    ).toEqual(
      new Set([
        'localhost',
        '127.0.0.1',
        '[::1]',
        'huabu.example.com',
        '192.168.1.50',
        'admin.example.com',
      ]),
    );
  });

  it('defers invalid public-origin reporting to deployment validation', () => {
    expect(
      resolveAllowedHostnames({
        HUABU_PUBLIC_ORIGIN: 'file:///tmp/huabu',
      }),
    ).toEqual(new Set(['localhost', '127.0.0.1', '[::1]']));
  });
});
