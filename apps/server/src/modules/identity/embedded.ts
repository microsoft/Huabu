// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  authenticateBubbleRequest,
  bubbleAuthContextToPrincipal,
  BubbleErrorCode,
  isBubbleProtocolError,
} from '@octostaff/sdk';

import { identityPrincipalSchema } from '@huabu/shared';

import { hasSystemOwnerGrant } from './bubble.js';
import { IdentityError } from './service.js';

import type { IdentityService } from './service.js';
import type { BubbleRuntime } from '@octostaff/bubble';

/**
 * In-process adapter over a host-composed Bubble runtime. The runtime's
 * verifier and identity registration are the same path Bubble's own routes
 * use, so a principal resolves identically through `/api/identity` and a
 * mounted Bubble API. Store and verifier lifetimes stay with the caller.
 */
export function createEmbeddedBubbleIdentityService(
  runtime: Pick<BubbleRuntime, 'authenticator' | 'application'>,
): IdentityService {
  const { identity } = runtime.application;
  return {
    provider: 'bubble',
    challenge: 'Bearer realm="Huabu"',
    async authenticate({ authorization }) {
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
      try {
        // Huabu admits on the Authorization header alone; verifiers that read
        // other headers (such as the master-key principal override) see none.
        const auth = await authenticateBubbleRequest(runtime.authenticator, {
          authorization,
          method: 'GET',
          url: '/v1/auth/whoami',
          getHeader: (name) =>
            name.toLowerCase() === 'authorization' ? authorization : undefined,
        });
        // Registration binds (issuer, subject) and refuses disabled accounts.
        const registered = await identity.register(auth, 'http');
        const whoami = await identity.whoAmIFor(
          { actorPrincipalId: registered.principalId },
          bubbleAuthContextToPrincipal(registered),
        );
        return {
          principal: identityPrincipalSchema.parse(whoami.principal),
          owner: hasSystemOwnerGrant(whoami.grants),
        };
      } catch (error) {
        if (isBubbleProtocolError(error)) {
          if (error.code === BubbleErrorCode.Unauthenticated) return null;
          if (error.code === BubbleErrorCode.Forbidden)
            throw new IdentityError(
              403,
              'IDENTITY_FORBIDDEN',
              'Identity access denied',
            );
        }
        // Store and verifier failures must never appear in a response.
        throw new IdentityError(
          503,
          'IDENTITY_UNAVAILABLE',
          'Identity service unavailable',
        );
      }
    },
  };
}
