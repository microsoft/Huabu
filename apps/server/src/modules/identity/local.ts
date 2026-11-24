// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { timingSafeEqual } from 'node:crypto';

import { UNRESTRICTED_ACCESS } from './service.js';

import type { IdentityService, ResolvedIdentity } from './service.js';

/** Carries the desktop app's launch token on every request its windows make. */
export const DESKTOP_TOKEN_HEADER = 'x-huabu-desktop-token';

/**
 * No directory or login server is needed for the existing single-owner mode.
 * With Basic Auth configured only its credential is admitted; without it every
 * caller is admitted, whatever Authorization header a proxy may add, and the
 * owner is whoever reaches the Server over loopback, or anyone when login is
 * explicitly disabled.
 *
 * Loopback alone does not say who is calling: every program on the machine,
 * and every other user of it, reaches the same port. The desktop app therefore
 * starts its Server with a launch token only its own windows hold, and a
 * caller without it is not admitted at all.
 */
export function createLocalIdentityService(
  options: {
    username?: string;
    password?: string;
    open?: boolean;
    launchToken?: string;
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
  const launchToken =
    !expected && options.launchToken
      ? Buffer.from(options.launchToken)
      : undefined;
  const matches = (supplied: Buffer, secret: Buffer) =>
    supplied.length === secret.length && timingSafeEqual(supplied, secret);
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
    // Not a scheme a browser answers with a login prompt.
    challenge: launchToken
      ? 'HuabuDesktop realm="Huabu"'
      : 'Basic realm="Huabu"',
    // The launch token names the desktop window, not a person: the RFS
    // surface still asks for the machine credential.
    credentialFree: !expected,
    async authenticate({ authorization, loopback, header }) {
      if (!expected) {
        if (
          launchToken &&
          !matches(
            Buffer.from(header?.(DESKTOP_TOKEN_HEADER) ?? ''),
            launchToken,
          )
        )
          return null;
        return local(loopback || Boolean(options.open));
      }
      return matches(Buffer.from(authorization ?? ''), expected)
        ? local(true)
        : null;
    },
    machineOwner: (loopback) => loopback || Boolean(options.open),
  };
}
