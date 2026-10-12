// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

/** Huabu's principal projection; credentials and provider claims stay server-side. */
export const identityPrincipalSchema = z.object({
  principalId: z.string().min(1),
  kind: z.enum(['user', 'bot', 'system']),
  displayName: z.string().optional(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type IdentityPrincipal = z.infer<typeof identityPrincipalSchema>;

export const identityResponseSchema = z.object({
  provider: z.enum(['local', 'bubble']),
  principal: identityPrincipalSchema,
  /** May use Huabu at all. */
  member: z.boolean(),
  /** May also change settings, credentials and agent configuration. */
  owner: z.boolean(),
});
export type IdentityResponse = z.infer<typeof identityResponseSchema>;
