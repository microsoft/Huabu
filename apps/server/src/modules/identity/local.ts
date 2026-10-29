// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { timingSafeEqual } from 'node:crypto';

import { UNRESTRICTED_ACCESS } from './service.js';

import type { IdentityService, ResolvedIdentity } from './service.js';

/**
 * No directory or login server is needed for the existing single-owner mode.
 * With Basic Auth configured only its credential is admitted; without it every
 * caller is admitted, whatever Authorization header a proxy may add, and the
 * owner is whoever reaches the Server over loopback, or anyone when login is
 * explicitly disabled.
 */
export function createLocalIdentityService(
  options: {
    username?: string;
    password?: string;
    open?: boolean;
  } = {},
): IdentityService {
  if (Boolean(options.username) !== Boolean(options.password)) {
    throw new Error('Local identity requires both Basic Auth values');
  }
  const expected =
    options.username && options.password
      ? Buffer.from(
          `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`,
        )
      : undefined;
  const local = (owner: boolean): ResolvedIdentity => ({
    principal: {
      principalId: 'local-owner',
      kind: 'user',
      displayName: 'Local owner',
    },
    member: true,
    owner,
    access: UNRESTRICTED_ACCESS,
  });

  return {
    provider: 'local',
    challenge: 'Basic realm="Huabu"',
    credentialFree: !expected,
    async authenticate({ authorization, loopback }) {
      if (!expected) return local(loopback || Boolean(options.open));
      const supplied = Buffer.from(authorization ?? '');
      return supplied.length === expected.length &&
        timingSafeEqual(supplied, expected)
        ? local(true)
        : null;
    },
    machineOwner: (loopback) => loopback || Boolean(options.open),
  };
}
