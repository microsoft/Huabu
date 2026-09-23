// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { timingSafeEqual } from 'node:crypto';

import type { IdentityService } from './service.js';

/** No directory or login server is needed for the existing single-owner mode. */
export function createLocalIdentityService(
  options: {
    username?: string;
    password?: string;
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

  return {
    provider: 'local',
    challenge: 'Basic realm="Huabu"',
    async authenticate({ authorization, loopback }) {
      if (expected) {
        const supplied = Buffer.from(authorization ?? '');
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          return null;
      } else if (!loopback || authorization) {
        return null;
      }
      return {
        principal: {
          principalId: 'local-owner',
          kind: 'user',
          displayName: 'Local owner',
        },
        owner: true,
      };
    },
  };
}
