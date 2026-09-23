// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { identityPrincipalSchema } from '@huabu/shared';

import { validateBubbleUrl } from './config.js';
import { IdentityError } from './service.js';

import type { IdentityService } from './service.js';

// Decode only the public whoami fields this adapter consumes. Neither Bubble
// grants nor transport details escape into Huabu's identity contract.
const whoamiSchema = z.object({
  principal: identityPrincipalSchema.extend({
    disabledAt: z.string().optional(),
  }),
  grants: z.array(
    z.object({
      target: z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('thread'), threadId: z.string() }),
        z.object({ type: z.literal('principal'), principalId: z.string() }),
      ]),
      role: z.string(),
    }),
  ),
});

/** HTTP adapter now; an embedded adapter can implement the same host contract. */
export function createBubbleIdentityService(baseUrl: string): IdentityService {
  const endpoint = `${validateBubbleUrl(baseUrl)}/v1/auth/whoami`;
  return {
    provider: 'bubble',
    challenge: 'Bearer realm="Huabu"',
    async authenticate({ authorization }) {
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
      try {
        const response = await fetch(endpoint, {
          headers: { authorization },
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          if (response.status === 401) return null;
          throw new IdentityError(
            403,
            'IDENTITY_FORBIDDEN',
            'Identity access denied',
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Bubble identity request failed');
        }
        const identity = whoamiSchema.parse(await response.json());
        if (identity.principal.disabledAt) {
          throw new IdentityError(
            403,
            'IDENTITY_FORBIDDEN',
            'Identity access denied',
          );
        }
        return {
          principal: identityPrincipalSchema.parse(identity.principal),
          owner: identity.grants.some(
            (grant) => grant.target.type === 'system' && grant.role === 'owner',
          ),
        };
      } catch (error) {
        if (error instanceof IdentityError) throw error;
        // Upstream URLs, errors and credentials must never appear in a response.
        throw new IdentityError(
          503,
          'IDENTITY_UNAVAILABLE',
          'Identity service unavailable',
        );
      }
    },
  };
}
