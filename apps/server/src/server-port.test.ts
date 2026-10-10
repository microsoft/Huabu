// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SERVER_PORT, resolveServerPort } from './server-port.js';

describe('resolveServerPort', () => {
  it('uses the documented fixed default when unset', () => {
    expect(resolveServerPort({})).toBe(DEFAULT_SERVER_PORT);
  });

  it('accepts a configured fixed port', () => {
    expect(resolveServerPort({ SERVER_PORT: '4100' })).toBe(4100);
  });

  it.each(['0', '65536', '3001extra', '3.1', '-1'])(
    'rejects invalid configured port %s',
    (value) => {
      expect(() => resolveServerPort({ SERVER_PORT: value })).toThrow(
        /SERVER_PORT/,
      );
    },
  );

  it('does not recognize the undocumented PORT alias', () => {
    expect(resolveServerPort({ PORT: '4100' })).toBe(DEFAULT_SERVER_PORT);
  });
});
