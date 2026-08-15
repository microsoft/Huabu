// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { decideViteAccess } from './vite-access';

describe('Vite access gate', () => {
  it('keeps zero-configuration loopback development', () => {
    expect(
      decideViteAccess({
        peer: '127.0.0.1',
        expectedAuthorization: null,
        receivedAuthorization: undefined,
      }),
    ).toBe('allow');
  });

  it('rejects an unauthenticated remote client before proxying', () => {
    expect(
      decideViteAccess({
        peer: '192.0.2.10',
        expectedAuthorization: null,
        receivedAuthorization: undefined,
      }),
    ).toBe('remote-auth-configuration-required');
  });

  it('allows the remote owner with matching Basic Auth', () => {
    expect(
      decideViteAccess({
        peer: '192.0.2.10',
        expectedAuthorization: 'Basic owner',
        receivedAuthorization: 'Basic owner',
      }),
    ).toBe('allow');
  });
});
